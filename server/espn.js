// Données ESPN (sans clé) : fiche de match complète et effectif du PSG avec stats par compétition.
const { Espn } = require("./providers");

const UA = "Mozilla/5.0 (compatible; ActuPSG/1.3; +https://github.com/xezy-b2/actu-psg)";
const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const PSG_ID = "160";
const LEAGUES = { FL1: "fra.1", CL: "uefa.champions" };

async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/* ---------------- Fiche de match ---------------- */
const STAT_KEYS = {
  possessionPct: "Possession", totalShots: "Tirs", shotsOnTarget: "Tirs cadrés", wonCorners: "Corners",
  foulsCommitted: "Fautes", offsides: "Hors-jeu", yellowCards: "Cartons jaunes", redCards: "Cartons rouges",
  saves: "Arrêts", passPct: "Passes réussies",
};

function eventKind(type) {
  const t = String(type || "");
  if (/own-goal|own---goal/.test(t)) return "own";
  if (/penalty---scored/.test(t)) return "pen";
  if (/penalty---(saved|missed)|missed/.test(t)) return "penmiss";
  if (/goal/.test(t)) return "goal";
  if (/yellow-red|second-yellow/.test(t)) return "yellowred";
  if (/red-card/.test(t)) return "red";
  if (/yellow-card/.test(t)) return "yellow";
  if (/substitution/.test(t)) return "sub";
  return null;
}

function buildSheet(summary, league) {
  const comp = summary.header?.competitions?.[0] || {};
  const cps = comp.competitors || [];
  const sideOf = id => (cps.find(c => c.team?.id === id)?.homeAway) || null;
  const teamBlock = side => {
    const c = cps.find(x => x.homeAway === side) || {};
    const box = (summary.boxscore?.teams || []).find(t => t.team?.id === c.team?.id);
    const roster = (summary.rosters || []).find(r => r.homeAway === side || r.team?.id === c.team?.id);
    const stats = {};
    for (const s of box?.statistics || []) if (STAT_KEYS[s.name]) stats[s.name] = Number(s.displayValue);
    const players = (roster?.roster || []).map(p => ({
      name: p.athlete?.displayName || "", jersey: p.jersey || "", pos: p.position?.abbreviation || "",
      starter: !!p.starter, in: !!p.subbedIn, out: !!p.subbedOut, place: Number(p.formationPlace) || 0,
    }));
    const hex = v => (/^[0-9a-f]{6}$/i.test(v || "") ? "#" + v : null);
    return { id: c.team?.id, name: c.team?.displayName || "", score: c.score != null ? Number(c.score) : null, formation: roster?.formation || "", color: hex(c.team?.color), altColor: hex(c.team?.alternateColor), stats, players };
  };
  const events = (summary.keyEvents || []).map(k => {
    const kind = eventKind(k.type?.type);
    if (!kind) return null;
    const names = (k.participants || []).map(p => p.athlete?.displayName).filter(Boolean);
    return {
      min: (k.clock?.displayValue || "").replace(/'/g, "").trim(),
      sort: k.clock?.value ?? 0,
      kind, side: sideOf(k.team?.id),
      player: names[0] || "",
      other: names[1] || "", // passeur décisif, ou joueur remplacé
    };
  }).filter(e => e && e.side).sort((a, b) => a.sort - b.sort).map(({ sort, ...e }) => e);

  const st = comp.status || {};
  const state = st.type?.name === "STATUS_HALFTIME" ? "HT" : st.type?.state === "in" ? "LIVE" : st.type?.state === "post" ? "FT" : "NS";
  return {
    eventId: summary.header?.id, league,
    date: comp.date || null,
    status: state, clock: st.displayClock || "",
    home: teamBlock("home"), away: teamBlock("away"),
    statLabels: STAT_KEYS,
    events,
    venue: summary.gameInfo?.venue?.fullName || null,
    attendance: summary.gameInfo?.attendance || null,
  };
}

async function fetchSheet(fixture, codeHint) {
  const espn = new Espn();
  if (codeHint && LEAGUES[codeHint]) espn.leagues = [LEAGUES[codeHint], ...espn.leagues.filter(l => l !== LEAGUES[codeHint])];
  const { league, ev } = await espn.findEvent({ ...fixture, refs: {} });
  const summary = await getJSON(`${BASE}/${league}/summary?event=${ev.id}`);
  return buildSheet(summary, league);
}

/* ---------------- Effectif et stats ---------------- */
const POS = { G: "Gardiens", D: "Défenseurs", M: "Milieux", F: "Attaquants" };
function posGroup(p) {
  const n = (p.position?.displayName || p.position?.name || "").toLowerCase(), a = p.position?.abbreviation || "";
  if (/goal/.test(n) || a === "G") return "G";
  if (/defen|back/.test(n) || /^(D|CD|LB|RB)/.test(a)) return "D";
  if (/mid/.test(n) || /^(M|DM|AM|CM)/.test(a)) return "M";
  return "F";
}
const flatStats = p => Object.fromEntries((p.statistics?.splits?.categories || []).flatMap(c => (c.stats || []).map(s => [s.name, s.value])));
const compStats = s => ({ app: s.appearances || 0, goals: s.totalGoals || 0, assists: s.goalAssists || 0, yellow: s.yellowCards || 0, red: s.redCards || 0, subIn: s.subIns || 0 });

function buildSquad(rosters) {
  const byId = new Map();
  for (const [code, r] of Object.entries(rosters)) {
    for (const p of r?.athletes || []) {
      const cur = byId.get(p.id) || {
        id: p.id, name: p.displayName, short: p.shortName || p.displayName, jersey: p.jersey || "",
        group: posGroup(p), pos: p.position?.displayName || "", age: p.age || null, nationality: p.citizenship || "",
        stats: {},
      };
      cur.stats[code] = compStats(flatStats(p));
      if (!cur.jersey && p.jersey) cur.jersey = p.jersey;
      byId.set(p.id, cur);
    }
  }
  const order = { G: 0, D: 1, M: 2, F: 3 };
  return [...byId.values()].sort((a, b) => order[a.group] - order[b.group] || (Number(a.jersey) || 99) - (Number(b.jersey) || 99));
}

function buildScorers(squad) {
  const out = {};
  for (const code of ["FL1", "CL"]) {
    const rows = squad.map(p => ({ name: p.short, full: p.name, jersey: p.jersey, ...(p.stats[code] || compStats({})) })).filter(r => r.goals || r.assists);
    out[code] = {
      goals: rows.filter(r => r.goals).sort((a, b) => b.goals - a.goals || b.assists - a.assists).slice(0, 8),
      assists: rows.filter(r => r.assists).sort((a, b) => b.assists - a.assists || b.goals - a.goals).slice(0, 8),
    };
  }
  return out;
}

async function fetchSquad() {
  const entries = await Promise.all(Object.entries(LEAGUES).map(async ([code, lg]) => [code, await getJSON(`${BASE}/${lg}/teams/${PSG_ID}/roster`).catch(() => null)]));
  const rosters = Object.fromEntries(entries.filter(([, r]) => r));
  if (!Object.keys(rosters).length) throw new Error("effectif ESPN indisponible");
  const squad = buildSquad(rosters);
  return { squad, scorers: buildScorers(squad), groups: POS };
}

module.exports = { buildSheet, fetchSheet, buildSquad, buildScorers, fetchSquad, eventKind, LEAGUES };
