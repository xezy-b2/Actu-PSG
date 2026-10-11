// Données récupérées automatiquement par le serveur, sans Claude ni GitHub :
// matchs du PSG et classement (football-data.org), fil d'actu (flux RSS).
const crypto = require("crypto");

const UA = "Mozilla/5.0 (compatible; ActuPSG/1.2; +https://github.com/xezy-b2/actu-psg)";
const COMP = { FL1: "Ligue 1", CL: "Ligue des champions", FRCH: "Trophée des champions", CDF: "Coupe de France" };

// "Paris Saint-Germain FC" → "Paris Saint-Germain", "Stade Rennais FC 1901" → "Stade Rennais"
function cleanTeam(name) {
  let n = String(name || "").trim();
  for (let i = 0; i < 3; i++) {
    const shorter = n.replace(/\s+(FC|AFC|CF|SC|AC|\d{4})$/i, "");
    // On garde le suffixe s'il ne resterait qu'un nom de ville court ("Paris FC").
    if (shorter === n || (!/\s/.test(shorter) && shorter.length < 6)) break;
    n = shorter;
  }
  return n;
}
const crest = t => (typeof t?.crest === "string" && /^https:\/\//.test(t.crest) ? t.crest : null);
const isPSG = n => /paris s(ain)?t?[- ]?g|^psg$/i.test(n || "");

/* ---------------- football-data.org ---------------- */
async function fdGet(key, path) {
  const res = await fetch("https://api.football-data.org/v4" + path, { headers: { "X-Auth-Token": key, "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.errorCode) throw new Error(j.message || `${res.status} ${res.statusText}`);
  return j;
}

function competitionLabel(m) {
  const base = COMP[m.competition?.code] || m.competition?.name || "";
  return m.matchday && ["FL1", "CL"].includes(m.competition?.code) ? `${base} · J${m.matchday}` : base;
}

// Transforme les matchs football-data en champs du site (results, fixtures, nextMatch).
function buildMatches(matches, now = Date.now()) {
  const list = (matches || []).map(m => ({
    raw: m,
    t: Date.parse(m.utcDate),
    homeCrest: crest(m.homeTeam), awayCrest: crest(m.awayTeam),
    home: cleanTeam(m.homeTeam?.name),
    away: cleanTeam(m.awayTeam?.name),
    competition: competitionLabel(m),
    status: m.status,
  })).sort((a, b) => a.t - b.t);

  const finished = list.filter(m => m.status === "FINISHED");
  const results = finished.slice(-10).reverse().map(m => ({
    date: new Date(m.t).toISOString().slice(0, 10),
    competition: m.competition, home: m.home, away: m.away,
    hs: m.raw.score?.fullTime?.home ?? 0, as: m.raw.score?.fullTime?.away ?? 0,
  }));

  const upcoming = list.filter(m => ["SCHEDULED", "TIMED"].includes(m.status) && m.t > now - 3 * 3600e3);
  const live = list.find(m => ["IN_PLAY", "PAUSED", "LIVE"].includes(m.status));
  // Un match fini reste affiché en "final" pendant 12 h.
  const justFinished = finished.filter(m => now - m.t < 14 * 3600e3).pop();
  const cur = live || justFinished || upcoming[0] || null;

  const fixtures = upcoming.filter(m => m !== cur).slice(0, 6).map(m => ({
    date: m.status === "TIMED" ? new Date(m.t).toISOString().replace(".000", "") : new Date(m.t).toISOString().slice(0, 10),
    competition: m.competition, home: m.home, away: m.away,
  }));

  let nextMatch = null;
  if (cur) {
    const st = cur.status === "FINISHED" ? "final" : ["IN_PLAY", "PAUSED", "LIVE"].includes(cur.status) ? "live" : "scheduled";
    const ref = (cur.raw.referees || []).find(r => !r.type || r.type === "REFEREE");
    nextMatch = {
      competition: COMP[cur.raw.competition?.code] || cur.raw.competition?.name || "",
      round: cur.raw.matchday ? `${cur.raw.matchday}e journée` : "",
      home: cur.home, away: cur.away,
      ...(cur.homeCrest ? { homeCrest: cur.homeCrest } : {}),
      ...(cur.awayCrest ? { awayCrest: cur.awayCrest } : {}),
      kickoff: new Date(cur.t).toISOString().replace(".000", ""),
      ...(cur.raw.venue ? { venue: cur.raw.venue } : {}),
      ...(ref?.name ? { referee: ref.name } : {}),
      status: st,
      score: st === "scheduled" ? { home: null, away: null } : { home: cur.raw.score?.fullTime?.home ?? 0, away: cur.raw.score?.fullTime?.away ?? 0 },
      minute: null,
      events: [],
    };
  }
  // Écusson de chaque équipe croisée, par nom affiché.
  const crests = {};
  for (const m of list) { if (m.homeCrest) crests[m.home] = m.homeCrest; if (m.awayCrest) crests[m.away] = m.awayCrest; }
  return { results, fixtures, nextMatch, crests };
}

function buildStandings(j) {
  const table = (j.standings || []).find(s => s.type === "TOTAL")?.table || [];
  return table.map(r => ({ rank: r.position, team: cleanTeam(r.team?.name), ...(crest(r.team) ? { crest: crest(r.team) } : {}), w: r.won, d: r.draw, l: r.lost, pts: r.points, played: r.playedGames }));
}

/* ---------------- Flux RSS ---------------- */
const DEFAULT_FEEDS = [
  { url: "https://www.footmercato.net/flux-rss", source: "Foot Mercato", filter: true },
  { url: "https://news.google.com/rss/search?q=PSG+football+when:2d&hl=fr&gl=FR&ceid=FR:fr", source: null, filter: false },
];

const decode = s => String(s || "")
  .replace(/^<!\[CDATA\[|\]\]>$/g, "")
  .replace(/<[^>]+>/g, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i")); return m ? decode(m[1]) : ""; };
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gi"))].map(m => decode(m[1]));

function parseRss(xml) {
  return [...String(xml).matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map(m => {
    const it = m[0];
    return { title: tag(it, "title"), link: tag(it, "link") || tag(it, "guid"), pubDate: tag(it, "pubDate"), source: tag(it, "source"), categories: tags(it, "category") };
  });
}

function categorize(title) {
  const t = title.toLowerCase();
  if (/mercato|transfert|prolong|contrat|recrue|offre|signe |signature|prêt|vente|bon de sortie/.test(t)) return "mercato";
  if (/bless|forfait|infirmerie|incertain|touché|out |opéré|rechute|ménag/.test(t)) return "infirmerie";
  if (/compo|composition|titulaire|onze|xi /.test(t)) return "compo";
  if (/ligue des champions|champions league|\bldc\b|europe/.test(t)) return "europe";
  if (/score|victoire|défaite|nul |\d+-\d+|but |doublé|triplé|match|résumé|notes /.test(t)) return "match";
  return "club";
}

async function fetchNews(feeds = DEFAULT_FEEDS) {
  const results = await Promise.allSettled(feeds.map(async f => {
    const res = await fetch(f.url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const items = parseRss(await res.text());
    return items
      .filter(i => i.title && /^https:\/\//.test(i.link))
      .filter(i => !f.filter || i.categories.some(c => /\bpsg\b|paris saint-germain|paris sg/i.test(c)) || /\bpsg\b|paris saint-germain/i.test(i.title))
      .map(i => {
        let title = i.title, source = f.source || i.source || "";
        // Google News ajoute " - Source" à la fin du titre.
        if (!f.source && i.source && title.endsWith(" - " + i.source)) title = title.slice(0, -(i.source.length + 3));
        const d = Date.parse(i.pubDate);
        return {
          id: "rss-" + crypto.createHash("sha1").update(i.link).digest("hex").slice(0, 12),
          category: categorize(title), title, summary: "", source, url: i.link,
          publishedAt: isNaN(d) ? new Date().toISOString() : new Date(d).toISOString().replace(".000", ""),
        };
      });
  }));
  const status = Object.fromEntries(feeds.map((f, i) => [f.source || new URL(f.url).hostname, results[i].status === "fulfilled" ? { ok: true, items: results[i].value.length } : { ok: false, error: results[i].reason?.message }]));
  const all = results.flatMap(r => (r.status === "fulfilled" ? r.value : []));
  // Dédoublonnage par titre proche.
  const seen = new Set(), news = [];
  for (const n of all.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))) {
    const k = n.title.toLowerCase().replace(/[^a-z0-9à-ÿ]+/g, " ").slice(0, 60);
    if (seen.has(k)) continue;
    seen.add(k); news.push(n);
  }
  return { news: news.slice(0, 30), status };
}

/* ---------------- Rafraîchissement périodique ---------------- */
class AutoData {
  constructor({ key, teamId = 524, feeds, intervalMs = 10 * 60e3 }) {
    this.key = key; this.teamId = teamId; this.feeds = feeds || DEFAULT_FEEDS; this.intervalMs = intervalMs;
    this.data = {}; this.status = { matches: null, standings: null, feeds: null, lastRun: null };
  }
  start(onChange) {
    this.onChange = onChange;
    const run = () => this.refresh().catch(e => console.warn("[auto]", e.message));
    run(); this.timer = setInterval(run, this.intervalMs); this.timer.unref?.();
  }
  async refresh() {
    this.status.lastRun = new Date().toISOString();
    const tasks = [];
    if (this.key) {
      const day = ms => new Date(ms).toISOString().slice(0, 10);
      tasks.push(fdGet(this.key, `/teams/${this.teamId}/matches?dateFrom=${day(Date.now() - 75 * 864e5)}&dateTo=${day(Date.now() + 75 * 864e5)}`)
        .then(j => { Object.assign(this.data, buildMatches(j.matches)); this.status.matches = { ok: true, count: (j.matches || []).length }; })
        .catch(e => { this.status.matches = { ok: false, error: e.message }; }));
      tasks.push(fdGet(this.key, "/competitions/FL1/standings")
        .then(j => { const s = buildStandings(j); if (s.length) this.data.standings = s; this.status.standings = { ok: true, teams: s.length }; })
        .catch(e => { this.status.standings = { ok: false, error: e.message }; }));
    } else {
      this.status.matches = this.status.standings = { ok: false, error: "FOOTBALL_DATA_KEY absent" };
    }
    tasks.push(fetchNews(this.feeds)
      .then(({ news, status }) => { if (news.length) this.data.news = news; this.status.feeds = status; })
      .catch(e => { this.status.feeds = { error: e.message }; }));
    await Promise.all(tasks);
    this.onChange?.();
  }
}

module.exports = { AutoData, buildMatches, buildStandings, parseRss, categorize, cleanTeam, fetchNews, isPSG };
