// Relit data.json sur GitHub (mis à jour chaque heure par la tâche programmée)
// et prévient les abonnés "actu" des nouveaux articles.
const fs = require("fs");
const { sameStory } = require("./stories");

const DEFAULT_URL = "https://raw.githubusercontent.com/xezy-b2/actu-psg/main/data.json";
const CATEGORY_TITLE = { mercato: "Mercato", compo: "Compo", infirmerie: "Infirmerie", match: "Match", europe: "Europe", club: "Actu PSG" };

class DataSync {
  constructor({ url, localFile, store, notify, intervalMs = 2 * 60e3 }) {
    this.url = url || DEFAULT_URL;
    this.localFile = localFile;
    this.store = store;
    this.notify = notify;
    this.intervalMs = intervalMs;
    this.raw = null;
    this.etag = null;
    this.lastSync = null;
    this.updatedAt = null;
    this.lastError = null;
    try { this.raw = fs.readFileSync(localFile, "utf8"); this.updatedAt = JSON.parse(this.raw).updatedAt; } catch (e) {}
  }
  get base() { try { return JSON.parse(this.raw); } catch (e) { return {}; } }
  start(onChange) { this.onChange = onChange; this.sync(); this.timer = setInterval(() => this.sync(), this.intervalMs); this.timer.unref?.(); }
  async sync() {
    try {
      const res = await fetch(this.url + "?t=" + Date.now(), { headers: this.etag ? { "If-None-Match": this.etag } : {}, signal: AbortSignal.timeout(15000) });
      this.lastSync = new Date().toISOString();
      if (res.status === 304) return;
      if (!res.ok) throw new Error(`${res.status} sur ${this.url}`);
      const text = await res.text();
      const json = JSON.parse(text); // valide avant de remplacer
      this.raw = text;
      this.etag = res.headers.get("etag");
      this.updatedAt = json.updatedAt;
      this.lastError = null;
      this.onChange?.();
    } catch (e) {
      this.lastError = e.message;
      console.warn("[data]", e.message);
    }
  }
  async checkNews(news) {
    if (!this.store) return;
    const seen = await this.store.getKV("newsSeen");
    const ids = news.map(n => n.id).filter(Boolean);
    if (!seen) return this.store.setKV("newsSeen", ids); // première fois : on mémorise sans notifier
    if (ids.every(id => seen.includes(id))) return;
    await this.store.setKV("newsSeen", [...new Set([...ids, ...seen])].slice(0, 300));

    // Seulement les infos récentes (moins de 3 h), pour éviter une rafale au redémarrage.
    const fresh = news.filter(n => n.id && !seen.includes(n.id) && Date.now() - Date.parse(n.publishedAt) < 3 * 3600e3)
      .sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)));
    if (!fresh.length) return;

    // Infos déjà notifiées ces dernières 24 h : une même info reprise par plusieurs médias ne part qu'une fois.
    const now = Date.now();
    const sent = ((await this.store.getKV("newsNotified")) || []).filter(x => now - x.at < 24 * 3600e3);
    let changed = false;
    for (const n of fresh) {
      if (sent.some(x => sameStory(x.title, n.title))) continue;
      sent.push({ title: n.title, at: now }); changed = true;
      await this.notify("news", { title: CATEGORY_TITLE[n.category] || "Actu PSG", body: n.title, tag: `news-${n.id}`, topic: "news", url: "/#news" }, { ttl: 6 * 3600 });
    }
    if (changed) await this.store.setKV("newsNotified", sent.slice(-200));
  }

}

module.exports = { DataSync };
