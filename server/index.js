// Serveur Actu PSG : site, données, notifications et veilleur de match.
const path = require("path");
const fs = require("fs");
const express = require("express");
const { createStore } = require("./store");
const { setupVapid, broadcast, sendOne } = require("./push");
const { createProvider, fixtureFromData } = require("./providers");
const { Watcher } = require("./watcher");
const { DataSync } = require("./datasync");
const { AutoData } = require("./autodata");
const { mergeData } = require("./merge");

const ROOT = path.join(__dirname, "..");
const PORT = process.env.PORT || 3000;
const PREFS = ["goals", "match", "lineup", "news"];
const DEFAULT_PREFS = { goals: true, match: true, lineup: true, news: false };

function cleanPrefs(p) {
  const out = {};
  for (const k of PREFS) out[k] = typeof p?.[k] === "boolean" ? p[k] : DEFAULT_PREFS[k];
  return out;
}
function validSubscription(s) {
  return s && typeof s.endpoint === "string" && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1000
    && s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string";
}

// Petite limite de débit par IP pour les routes d'écriture.
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim() + req.path;
    const now = Date.now();
    const h = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (h.length >= max) return res.status(429).json({ error: "Trop de requêtes, réessayez dans une minute." });
    h.push(now); hits.set(key, h); next();
  };
}
setInterval(() => hits.clear(), 10 * 60e3).unref();

async function main() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "10kb" }));

  let store = null, publicKey = null, pushError = null;
  try {
    store = await createStore();
    publicKey = await setupVapid(store);
  } catch (e) {
    pushError = e.message;
    console.error("[push] Notifications désactivées :", e.message);
  }
  const notify = (pref, payload, opts) => (store && publicKey ? broadcast(store, pref, payload, opts) : Promise.resolve());

  const data = new DataSync({ url: process.env.DATA_URL, localFile: path.join(ROOT, "data.json"), store, notify });
  const auto = new AutoData({ key: process.env.FOOTBALL_DATA_KEY, teamId: Number(process.env.FOOTBALL_DATA_TEAM_ID) || 524 });
  let watcher = null;
  // Données servies au site, recalculées à chaque changement d'une des trois sources.
  let served = null;
  const rebuild = () => { served = JSON.stringify(mergeData(data.base, auto.data, watcher?.lastLive)); };
  const onChange = async () => { rebuild(); try { await data.checkNews(JSON.parse(served).news || []); } catch (e) { console.warn("[news]", e.message); } };
  data.start(onChange);
  auto.start(onChange);

  if (process.env.WATCHER_DISABLED !== "1") {
    const getFixture = () => { try { if (!served) rebuild(); return fixtureFromData(JSON.parse(served)); } catch (e) { return null; } };
    watcher = new Watcher({ store: store || new (require("./store").MemoryStore)(), provider: createProvider(), notify, getFixture, pollSeconds: Number(process.env.POLL_SECONDS) || undefined });
    watcher.onLive = rebuild;
    watcher.start();
  }

  /* ---------- Données ---------- */
  app.get("/data.json", (req, res) => {
    res.set("Cache-Control", "no-cache");
    if (!served) rebuild();
    res.type("application/json").send(served);
  });

  /* ---------- Notifications ---------- */
  app.get("/api/push/config", (req, res) => {
    if (!publicKey) return res.status(503).json({ error: "Notifications indisponibles", detail: pushError });
    res.json({ publicKey, prefs: PREFS, defaults: DEFAULT_PREFS });
  });
  app.post("/api/push/subscribe", rateLimit(20, 60e3), async (req, res) => {
    if (!publicKey) return res.status(503).json({ error: "Notifications indisponibles" });
    const { subscription, prefs } = req.body || {};
    if (!validSubscription(subscription)) return res.status(400).json({ error: "Abonnement invalide" });
    await store.upsertSubscription({ endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } }, cleanPrefs(prefs));
    res.json({ ok: true, prefs: cleanPrefs(prefs) });
  });
  app.post("/api/push/prefs", rateLimit(30, 60e3), async (req, res) => {
    if (!publicKey) return res.status(503).json({ error: "Notifications indisponibles" });
    const { endpoint } = req.body || {};
    const sub = typeof endpoint === "string" ? await store.getSubscription(endpoint) : null;
    if (!sub) return res.status(404).json({ error: "Abonnement introuvable" });
    res.json({ prefs: cleanPrefs(sub.prefs) });
  });
  app.post("/api/push/unsubscribe", rateLimit(20, 60e3), async (req, res) => {
    if (!publicKey) return res.status(503).json({ error: "Notifications indisponibles" });
    const { endpoint } = req.body || {};
    if (typeof endpoint === "string") await store.removeSubscription(endpoint);
    res.json({ ok: true });
  });
  app.post("/api/push/test", rateLimit(5, 60e3), async (req, res) => {
    if (!publicKey) return res.status(503).json({ error: "Notifications indisponibles" });
    const sub = typeof req.body?.endpoint === "string" ? await store.getSubscription(req.body.endpoint) : null;
    if (!sub) return res.status(404).json({ error: "Abonnement introuvable" });
    try {
      await sendOne(sub, { title: "Notifications activées", body: "Vous serez prévenu des buts et des temps forts du PSG.", tag: "test", url: "/" });
      res.json({ ok: true });
    } catch (e) {
      if ([404, 410].includes(e.statusCode)) await store.removeSubscription(sub.endpoint);
      res.status(502).json({ error: "L'envoi a échoué. Désactivez puis réactivez les notifications." });
    }
  });

  /* ---------- État du serveur ---------- */
  app.get("/healthz", (req, res) => res.json({ ok: true }));
  app.get("/api/status", async (req, res) => {
    res.json({
      push: { enabled: !!publicKey, store: store?.kind || null, subscribers: store ? await store.countSubscriptions().catch(() => null) : null },
      data: { source: data.url, lastSync: data.lastSync, updatedAt: data.updatedAt, error: data.lastError },
      auto: auto.status,
      watcher: watcher ? watcher.status : "désactivé",
    });
  });

  // Teste chaque source de score sur le dernier match joué (sans rien notifier).
  let lastProbe = null;
  app.get("/api/sources/check", rateLimit(3, 60e3), async (req, res) => {
    if (lastProbe && Date.now() - lastProbe.at < 60e3) return res.json(lastProbe.result);
    let d = {};
    try { if (!served) rebuild(); d = JSON.parse(served); } catch (e) {}
    const r = (d.results || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    if (!r) return res.status(404).json({ error: "Aucun match joué dans data.json" });
    const fixture = { id: "probe", kickoff: Date.parse(r.date + "T19:00:00Z"), home: r.home, away: r.away, refs: {} };
    const { Espn, FootballData, Sofascore, ApiFootball } = require("./providers");
    const list = [new Espn(), ...(process.env.FOOTBALL_DATA_KEY ? [new FootballData(process.env.FOOTBALL_DATA_KEY)] : []), new Sofascore(), ...(process.env.API_FOOTBALL_KEY ? [new ApiFootball(process.env.API_FOOTBALL_KEY)] : [])];
    const result = { match: `${r.home} ${r.hs}-${r.as} ${r.away} (${r.date})`, sources: {} };
    for (const p of list) {
      const t0 = Date.now();
      try {
        let out;
        if (p.name === "sofascore") { const j = await p.get("/team/1644/events/last/0"); out = { reachable: true, events: (j.events || []).length }; }
        else { const l = await p.live({ ...fixture, refs: {} }); out = { status: l.status, score: `${l.homeGoals}-${l.awayGoals}`, scorers: l.goals.map(g => `${g.player} ${g.minute}'`) }; }
        result.sources[p.name] = { ok: true, ms: Date.now() - t0, ...out };
      } catch (e) { result.sources[p.name] = { ok: false, ms: Date.now() - t0, error: e.message }; }
    }
    lastProbe = { at: Date.now(), result };
    res.json(result);
  });

  /* ---------- Fichiers du site ---------- */
  const files = { "/": "index.html", "/index.html": "index.html", "/manifest.webmanifest": "manifest.webmanifest", "/sw.js": "sw.js" };
  for (const [route, file] of Object.entries(files)) {
    app.get(route, (req, res) => {
      if (file === "sw.js") res.set({ "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" });
      else res.set("Cache-Control", "no-cache");
      res.sendFile(path.join(ROOT, file));
    });
  }
  app.use("/icons", express.static(path.join(ROOT, "icons"), { maxAge: "7d" }));
  app.use((req, res) => res.status(404).type("text/plain").send("Page introuvable"));

  app.listen(PORT, () => console.log(`[server] Actu PSG en ligne sur le port ${PORT}`));
}

main().catch(e => { console.error(e); process.exit(1); });
