// Ouvre les paquets WikiMasters dès qu'ils sont disponibles (+ 2 à 60 s au hasard)
// et envoie une notification ntfy pour chaque carte R, SR, UR ou L.
//
// Variables d'environnement :
//   WM_COOKIE    valeur de l'en-tête "cookie" d'une session WikiMasters (secret)
//   NTFY_TOPIC   nom de ton sujet ntfy (secret, optionnel)
//   RUN_MINUTES  durée max d'une exécution, en minutes (350 par défaut)
//
// La connexion du site (Supabase) expire toutes les heures et c'est normalement
// le navigateur qui la renouvelle. Le script la renouvelle donc lui-même, puis
// garde la session à jour dans jar.enc (chiffré avec WM_COOKIE comme clé), que
// le workflow conserve d'une exécution à l'autre.

const fs = require('fs');
const crypto = require('crypto');

const BASE = 'https://www.wiki-masters.com';
const COOKIE = process.env.WM_COOKIE;
const TOPIC = process.env.NTFY_TOPIC;
const END = Date.now() + Number(process.env.RUN_MINUTES || 350) * 60_000;
const RARE = ['R', 'SR', 'UR', 'L'];
const RARITY_NAME = { R: 'Rare', SR: 'Super rare', UR: 'Ultra rare', L: 'Légende' };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const CHUNK = 3180; // taille max d'un cookie Supabase avant découpage en .0, .1…

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = () => 2_000 + Math.random() * 58_000; // 2 à 60 s
const time = d => new Date(d).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' });

// ---------- Notifications ----------
async function notify(title, message, priority = 3) {
  if (!TOPIC) return;
  try {
    await fetch('https://ntfy.sh/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: TOPIC, title, message, priority }),
    });
  } catch (e) {
    console.log('Notification impossible :', e.message);
  }
}

async function fail(title, message) {
  console.log(`${title} : ${message}`);
  await notify(title, message, 5);
  process.exit(1);
}

// ---------- Cookies ----------
const JAR_FILE = 'jar.enc';
const KEY = crypto.createHash('sha256').update(String(COOKIE || '')).digest();
const jar = new Map();

function loadCookieString(str) {
  for (const part of str.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
}

const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

function loadJar() {
  try {
    const buf = fs.readFileSync(JAR_FILE);
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    loadCookieString(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
    console.log('Session reprise de l\'exécution précédente.');
    return true;
  } catch {
    return false;
  }
}

function saveJar() {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(cookieHeader(), 'utf8'), c.final()]);
  fs.writeFileSync(JAR_FILE, Buffer.concat([iv, c.getAuthTag(), enc]));
}

function absorb(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (!list.length) return;
  for (const sc of list) {
    const [pair, ...attrs] = sc.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
    const expired = attrs.some(a => /^\s*max-age=0\s*$/i.test(a)) ||
      attrs.some(a => /^\s*expires=/i.test(a) && new Date(a.split('=')[1]) < new Date());
    if (expired || value === '') jar.delete(name); else jar.set(name, value);
  }
  saveJar();
}

// ---------- Session Supabase ----------
function authCookieBase() {
  for (const k of jar.keys()) {
    const m = k.match(/^(sb-([a-z0-9]+)-auth-token)(\.\d+)?$/);
    if (m) return { base: m[1], ref: m[2] };
  }
  return null;
}

function readSession() {
  const a = authCookieBase();
  if (!a) return null;
  let raw = jar.get(a.base);
  if (raw == null) {
    raw = '';
    for (let i = 0; jar.has(`${a.base}.${i}`); i++) raw += jar.get(`${a.base}.${i}`);
  }
  raw = decodeURIComponent(raw);
  try {
    const json = raw.startsWith('base64-') ? Buffer.from(raw.slice(7), 'base64url').toString('utf8') : raw;
    return { ...a, session: JSON.parse(json) };
  } catch {
    return null;
  }
}

function writeSession(base, session) {
  const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  for (const k of [...jar.keys()]) if (k === base || k.startsWith(base + '.')) jar.delete(k);
  if (value.length <= CHUNK) jar.set(base, value);
  else for (let i = 0; i * CHUNK < value.length; i++) jar.set(`${base}.${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK));
  saveJar();
}

let anonKey = null;
async function findAnonKey(ref) {
  if (anonKey) return anonKey;
  for (const page of ['/login', '/pulls']) {
    const html = await (await fetch(BASE + page, { headers: { 'user-agent': UA, cookie: cookieHeader() } })).text();
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => new URL(m[1].replace(/&amp;/g, '&'), BASE).href);
    for (const src of srcs) {
      if (!src.startsWith(BASE)) continue;
      const js = await (await fetch(src, { headers: { 'user-agent': UA } })).text();
      for (const m of js.matchAll(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g)) {
        try {
          const p = JSON.parse(Buffer.from(m[0].split('.')[1], 'base64url').toString());
          if (p.role === 'anon' && p.ref === ref) return (anonKey = m[0]);
        } catch {}
      }
    }
  }
  throw new Error('clé publique Supabase introuvable sur le site');
}

async function refreshSession(force = false) {
  const s = readSession();
  if (!s) return fail('WikiMasters : connexion illisible', 'Le cookie WM_COOKIE ne contient pas de session. Recopie-le (voir README).');
  const expiresAt = (s.session.expires_at || 0) * 1000;
  if (!force && expiresAt - Date.now() > 10 * 60_000) return;
  const key = await findAnonKey(s.ref);
  const res = await fetch(`https://${s.ref}.supabase.co/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: s.session.refresh_token }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) {
    return fail('WikiMasters : connexion perdue',
      `Renouvellement refusé (HTTP ${res.status}). Recopie un cookie depuis une fenêtre de navigation privée dans le secret WM_COOKIE (voir README), puis relance le workflow.`);
  }
  if (!body.expires_at) body.expires_at = Math.floor(Date.now() / 1000) + (body.expires_in || 3600);
  writeSession(s.base, body);
  console.log(`${time(Date.now())} connexion renouvelée (valable jusqu'à ${time(body.expires_at * 1000)})`);
}

// ---------- Ouverture ----------
async function openPack() {
  await refreshSession();
  const headers = { cookie: cookieHeader(), origin: BASE, referer: `${BASE}/pulls`, 'user-agent': UA };
  const page = await fetch(`${BASE}/pulls`, { headers, redirect: 'manual' }).catch(() => null);
  if (page) { absorb(page); await page.arrayBuffer().catch(() => {}); }
  await sleep(1_500 + Math.random() * 2_500);
  const res = await fetch(`${BASE}/api/packs/open`, { method: 'POST', headers: { ...headers, cookie: cookieHeader() }, redirect: 'manual' });
  absorb(res);
  const text = await res.text().catch(() => '');
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, text };
}

async function main() {
  if (!COOKIE) throw new Error('WM_COOKIE manquant');
  if (!loadJar()) loadCookieString(COOKIE);
  let opened = 0, errors = 0, authRetried = false;

  while (Date.now() < END) {
    const { status, body, text } = await openPack();

    if (status === 200 && body?.cards) {
      opened++; errors = 0; authRetried = false;
      const rares = body.cards.filter(c => RARE.includes(c.rarity));
      console.log(`${time(Date.now())} paquet ouvert : ${body.cards.map(c => c.rarity).join(' ')} (reste ${body.packs_remaining})`);
      for (const c of rares) {
        await notify(
          `${RARITY_NAME[c.rarity]} : ${c.wikipedia_title}`,
          `${c.rarity} · ATK ${c.atk} / DEF ${c.def}\n${c.wikipedia_url || ''}`,
          c.rarity === 'R' ? 3 : 4,
        );
      }
      // Paquets en stock : on enchaîne après un court délai.
      // Sinon : prochain paquet 10 min après la dernière recharge.
      let wait = jitter();
      if (body.packs_remaining === 0 && body.packs_last_regen_at) {
        wait = new Date(body.packs_last_regen_at).getTime() + 600_000 - Date.now() + jitter();
      }
      await sleepUntil(Date.now() + Math.max(wait, 2_000));
      continue;
    }

    if (status === 403 && body?.next_regen_at) {
      errors = 0;
      const next = new Date(body.next_regen_at).getTime() + jitter();
      console.log(`${time(Date.now())} aucun paquet, prochain vers ${time(next)}`);
      await sleepUntil(next);
      continue;
    }

    // Non connecté : on tente un renouvellement forcé une fois.
    if (status === 401 && !authRetried) {
      authRetried = true;
      console.log(`${time(Date.now())} HTTP 401, renouvellement de la connexion…`);
      await refreshSession(true);
      continue;
    }
    if (status === 401) {
      await fail('WikiMasters : connexion perdue',
        'Le site ne reconnaît plus la session. Recopie un cookie depuis une fenêtre de navigation privée dans le secret WM_COOKIE (voir README), puis relance le workflow.');
    }

    // Autre erreur (protection anti-robot, site en panne…) : on réessaie plus tard.
    errors++;
    const snippet = text.replace(/\s+/g, ' ').slice(0, 200);
    console.log(`${time(Date.now())} réponse inattendue HTTP ${status} (essai ${errors}/6) : ${snippet}`);
    if (errors >= 6) {
      await fail('WikiMasters : ouverture bloquée', `Le site refuse les ouvertures depuis ~1 h (HTTP ${status}). Détail : ${snippet}`);
    }
    await sleepUntil(Date.now() + Math.min(2 ** errors, 20) * 60_000 + jitter());
  }
  console.log(`Fin de l'exécution, ${opened} paquet(s) ouvert(s).`);
}

async function sleepUntil(t) {
  if (t > END) { console.log('La suite sera faite par l\'exécution suivante.'); process.exit(0); }
  await sleep(Math.max(0, t - Date.now()));
}

main().catch(async e => {
  await fail('WikiMasters : erreur du script', e.message);
});
