const { sameStory } = require("./stories");
// Assemble les données servies au site :
//  - base : data.json du dépôt (contenu rédigé : compo, infirmerie, mercato, actu détaillée) ;
//  - auto : données récupérées par le serveur (matchs, classement, fil RSS) ;
//  - live : score en direct relevé par le veilleur.
const sameMatch = (a, b) => !!(a && b && a.home && b.home &&
  norm(a.home) === norm(b.home) && norm(a.away) === norm(b.away) &&
  Math.abs(Date.parse(a.kickoff) - Date.parse(b.kickoff)) < 6 * 3600e3);
function norm(n) {
  return String(n || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\b(fc|afc|cf|sc|ac|osc|as|ogc|rc|aj|sco|olympique|de|du|la)\b|\d{4}/g, "").replace(/[^a-z]/g, "")
    .replace(/^parissaintgermain$|^psg$/, "psg");
}

function goalText(g, home, away) {
  const team = g.side === "home" ? home : away;
  const extra = g.detail === "pen" ? " (pen.)" : g.detail === "csc" ? " (c.s.c.)" : "";
  return g.player ? `But de ${g.player}${extra} · ${team}` : `But · ${team}`;
}

function mergeData(base = {}, auto = {}, live = null, now = Date.now(), ai = null) {
  const out = { ...base };
  if (auto.results?.length) out.results = auto.results;
  if (auto.fixtures?.length) out.fixtures = auto.fixtures;
  if (auto.standings?.length) out.standings = auto.standings;
  const crests = { ...(auto.crests || {}) };
  for (const t of auto.standings || []) if (t.crest) crests[t.team] = t.crest;
  if (Object.keys(crests).length) out.crests = crests;

  // Prochain match : celui de football-data, enrichi des infos rédigées si c'est le même.
  if (auto.nextMatch) {
    const same = sameMatch(base.nextMatch, auto.nextMatch);
    out.nextMatch = same
      ? { ...base.nextMatch, ...pick(auto.nextMatch, ["home", "away", "homeCrest", "awayCrest", "kickoff", "competition", "round", "status", "score"]), venue: base.nextMatch.venue || auto.nextMatch.venue, referee: base.nextMatch.referee || auto.nextMatch.referee }
      : { ...auto.nextMatch };
    if (!same) { delete out.nextMatch.sofascoreId; out.lineup = null; }
  }

  // Score en direct du veilleur (plus frais que football-data pendant le match).
  if (live && out.nextMatch && sameMatch(out.nextMatch, live.fixture) && now - live.at < 15 * 60e3) {
    const l = live.live, m = out.nextMatch;
    if (l.status === "LIVE" || l.status === "HT") m.status = "live";
    else if (l.status === "FT") m.status = "final";
    if (l.status !== "NS") m.score = { home: l.homeGoals, away: l.awayGoals };
    m.minute = l.status === "HT" ? "MT" : l.minute ?? m.minute ?? null;
    if (l.goals?.length) m.events = l.goals.map(g => ({ min: g.minute, text: goalText(g, m.home, m.away) }));
  }

  // Fil d'actu : articles rédigés + titres RSS, sans doublons, du plus récent au plus ancien.
  // Une même info reprise par plusieurs médias n'apparaît qu'une fois (on garde l'article rédigé s'il existe).
  const seen = new Set(), kept = [];
  const all = [...(base.news || []).map(n => ({ ...n, _ed: 1 })), ...(auto.news || [])]
    .filter(n => n && n.title && !seen.has(n.url || n.id) && seen.add(n.url || n.id))
    .sort((a, b) => (b._ed || 0) - (a._ed || 0) || String(b.publishedAt).localeCompare(String(a.publishedAt)));
  for (const n of all) if (!kept.some(k => sameStory(k.title, n.title))) kept.push(n);
  out.news = kept.map(({ _ed, ...n }) => n)
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
    .slice(0, 30);

  // Éditorial généré par l'API Claude (s'il est configuré) : prioritaire s'il concerne le bon match.
  if (ai && ai.updatedAt) {
    if (ai.lineup?.lines?.length && out.nextMatch && sameMatch(out.nextMatch, ai.forMatch)) out.lineup = ai.lineup;
    if (Array.isArray(ai.absents)) out.absents = ai.absents;
    if (ai.transfers) out.transfers = { ...(out.transfers || {}), ...ai.transfers };
    out.editorialUpdatedAt = ai.updatedAt;
  }

  // Fiche de match, effectif et buteurs (ESPN).
  if (auto.matchSheet) out.matchSheet = auto.matchSheet;
  if (auto.scorers) out.scorers = auto.scorers;
  if (auto.squad?.length) {
    const lastName = n => norm2(String(n).split(" ").slice(-1)[0]);
    const statusOf = p => (out.absents || []).find(a => lastName(a.name) === lastName(p.name) || norm2(a.name) === norm2(p.name));
    out.squad = auto.squad.map(p => { const a = statusOf(p); return a ? { ...p, status: a.status, statusReason: a.reason } : p; });
    out.squadGroups = auto.squadGroups;
  }

  out.updatedAt = new Date(now).toISOString();
  return out;
}

const norm2 = n => String(n || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
function pick(o, keys) { return Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]])); }

module.exports = { mergeData, sameMatch, norm };
