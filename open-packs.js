// Ouvre les paquets WikiMasters dès qu'ils sont disponibles (+ 2 à 60 s au hasard)
// et envoie une notification ntfy pour chaque carte R, SR, UR ou L.
//
// Variables d'environnement :
//   WM_COOKIE    valeur de l'en-tête "cookie" de ta session WikiMasters (secret)
//   NTFY_TOPIC   nom de ton sujet ntfy (secret, optionnel)
//   RUN_MINUTES  durée max d'une exécution, en minutes (350 par défaut)
//
// La connexion du site se renouvelle environ toutes les heures. Le script garde
// donc les cookies renouvelés dans jar.enc (chiffré avec WM_COOKIE comme clé),
// que le workflow conserve d'une exécution à l'autre.

const fs = require('fs');
const crypto = require('crypto');
const BASE = 'https://www.wiki-masters.com';
const COOKIE = process.env.WM_COOKIE;
const TOPIC = process.env.NTFY_TOPIC;
const END = Date.now() + Number(process.env.RUN_MINUTES || 350) * 60_000;
const RARE = ['R', 'SR', 'UR', 'L'];
const RARITY_NAME = { R: 'Rare', SR: 'Super rare', UR: 'Ultra rare', L: 'Légende' };

// ---- Cookies ----
const JAR_FILE = 'jar.enc';
const KEY = crypto.createHash('sha256').update(String(COOKIE || '')).digest();
const jar = new Map();

function loadCookieString(str) {
  for (const part of str.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
}

function loadJar() {
  try {
    const buf = fs.readFileSync(JAR_FILE);
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    const str = Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    loadCookieString(str);
    console.log('Cookies renouvelés repris de l\'exécution précédente.');
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

const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

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
  console.log(`Connexion renouvelée (${list.length} cookie(s) mis à jour).`);
}

const HEADERS = () => ({
  cookie: cookieHeader(),
  origin: BASE,
  referer: `${BASE}/pulls`,
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
});

// Charge la page des paquets, comme un navigateur : c'est là que le site renouvelle la connexion.
async function visitPulls() {
  try {
    const res = await fetch(`${BASE}/pulls`, { headers: HEADERS(), redirect: 'manual' });
    absorb(res);
    await res.arrayBuffer();
    return res.status;
  } catch (e) {
    console.log('Visite de /pulls impossible :', e.message);
    return 0;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = () => 2_000 + Math.random() * 58_000; // 2 à 60 s
const time = d => new Date(d).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' });

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

async function openPack() {
  const pageStatus = await visitPulls();
  await sleep(1_500 + Math.random() * 2_500);
  const res = await fetch(`${BASE}/api/packs/open`, { method: 'POST', headers: HEADERS(), redirect: 'manual' });
  absorb(res);
  if (pageStatus >= 300 && pageStatus < 400 && res.status !== 200) console.log(`/pulls redirige (HTTP ${pageStatus}) : connexion probablement perdue.`);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function main() {
  if (!COOKIE) throw new Error('WM_COOKIE manquant');
  if (!loadJar()) loadCookieString(COOKIE);
  let opened = 0;

  while (Date.now() < END) {
    const { status, body } = await openPack();

    if (status === 200 && body?.cards) {
      opened++;
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
      const next = new Date(body.next_regen_at).getTime() + jitter();
      console.log(`${time(Date.now())} aucun paquet, prochain vers ${time(next)}`);
      await sleepUntil(next);
      continue;
    }

    // Tout autre cas = session expirée ou site qui a changé.
    console.log(`Réponse inattendue : HTTP ${status}`);
    await notify('WikiMasters : ouverture bloquée',
      `HTTP ${status}. Ton cookie de session a probablement expiré : mets à jour le secret WM_COOKIE sur GitHub.`, 5);
    process.exit(1);
  }
  console.log(`Fin de l'exécution, ${opened} paquet(s) ouvert(s).`);
}

async function sleepUntil(t) {
  if (t > END) { console.log('Le prochain paquet sera ouvert par l\'exécution suivante.'); process.exit(0); }
  await sleep(Math.max(0, t - Date.now()));
}

main().catch(async e => {
  console.log('Erreur :', e.message);
  await notify('WikiMasters : erreur du script', e.message, 5);
  process.exit(1);
});
