// Envoi des notifications Web Push (clés VAPID générées une fois puis gardées en base).
const webpush = require("web-push");

async function setupVapid(store) {
  let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const saved = await store.getKV("vapid");
    if (saved?.publicKey && saved?.privateKey) ({ publicKey: pub, privateKey: priv } = saved);
    else {
      const k = webpush.generateVAPIDKeys();
      await store.setKV("vapid", k);
      ({ publicKey: pub, privateKey: priv } = k);
      console.log("[push] Nouvelles clés VAPID générées et enregistrées en base.");
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:contact@example.com", pub, priv);
  return pub;
}

// Envoie `payload` à tous les abonnés qui ont activé `pref`. Supprime les abonnements expirés.
async function broadcast(store, pref, payload, { urgency = "normal", ttl = 3600 } = {}) {
  const subs = await store.listSubscriptions(pref);
  const body = JSON.stringify(payload);
  let sent = 0, removed = 0;
  for (let i = 0; i < subs.length; i += 50) {
    const results = await Promise.allSettled(
      subs.slice(i, i + 50).map(s => webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: ttl, urgency, topic: payload.topic }))
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") sent++;
      else if ([404, 410].includes(r.reason?.statusCode)) { await store.removeSubscription(subs[i + j].endpoint); removed++; }
      else console.warn("[push] Échec d'envoi :", r.reason?.statusCode || r.reason?.message);
    }
  }
  console.log(`[push] "${payload.title}" → ${sent}/${subs.length} envoyées${removed ? `, ${removed} abonnements expirés supprimés` : ""}`);
  return { sent, total: subs.length, removed };
}

async function sendOne(sub, payload) {
  return webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 600, urgency: "high" });
}

module.exports = { setupVapid, broadcast, sendOne };
