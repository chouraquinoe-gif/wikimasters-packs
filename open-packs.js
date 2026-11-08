// Ouvre les paquets WikiMasters dès qu'ils sont disponibles (+ 2 à 60 s au hasard)
// et envoie une notification ntfy pour chaque carte R, SR, UR ou L.
//
// Variables d'environnement :
//   WM_COOKIE    valeur de l'en-tête "cookie" de ta session WikiMasters (secret)
//   NTFY_TOPIC   nom de ton sujet ntfy (secret, optionnel)
//   RUN_MINUTES  durée max d'une exécution, en minutes (350 par défaut)

const BASE = 'https://www.wiki-masters.com';
const COOKIE = process.env.WM_COOKIE;
const TOPIC = process.env.NTFY_TOPIC;
const END = Date.now() + Number(process.env.RUN_MINUTES || 350) * 60_000;
const RARE = ['R', 'SR', 'UR', 'L'];
const RARITY_NAME = { R: 'Rare', SR: 'Super rare', UR: 'Ultra rare', L: 'Légende' };

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
  const res = await fetch(`${BASE}/api/packs/open`, {
    method: 'POST',
    headers: {
      cookie: COOKIE,
      origin: BASE,
      referer: `${BASE}/pulls`,
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    },
    redirect: 'manual',
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function main() {
  if (!COOKIE) throw new Error('WM_COOKIE manquant');
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
