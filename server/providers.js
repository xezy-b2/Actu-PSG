// Sources de scores en direct, ramenées à un format commun.
//
// Fixture : { id, kickoff (ms), home, away, competition, refs: { sofascore?, espn?, apiFootball? } }
// Live    : { status: "NS" | "LIVE" | "HT" | "FT" | "OFF", minute, homeGoals, awayGoals,
//             goals: [{ minute, side: "home" | "away", player, detail }],
//             lineup: null | { formation, players: [noms du XI du PSG] } }
//
// Le match à suivre vient de data.json (mis à jour chaque heure). Les sources ne servent
// qu'au direct ; on les essaie dans l'ordre jusqu'à ce que l'une réponde.

const UA = "Mozilla/5.0 (compatible; ActuPSG/1.1; +https://github.com/xezy-b2/actu-psg)";
const isPSG = n => /paris s(ain)?t?[- ]?g|^psg$/i.test(n || "");

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}
const ymd = (ms, sep = "") => new Date(ms).toISOString().slice(0, 10).replace(/-/g, sep);
// Le 2e jour couvre un match qui finit après minuit UTC.
const matchDays = ms => [...new Set([ymd(ms), ymd(ms + 3 * 3600e3)])];

/* ---------------- ESPN (sans clé) ---------------- */
class Espn {
  constructor() {
    this.name = "espn";
    this.base = "https://site.api.espn.com/apis/site/v2/sports/soccer";
    this.leagues = ["fra.1", "uefa.champions", "fra.coupe_de_france", "fra.super_cup", "uefa.super_cup", "club.friendly"];
  }
  async findEvent(fixture) {
    const leagues = fixture.refs?.espnLeague ? [fixture.refs.espnLeague] : this.leagues;
    for (const league of leagues) {
      for (const day of matchDays(fixture.kickoff)) {
        const sb = await getJSON(`${this.base}/${league}/scoreboard?dates=${day}`).catch(() => null);
        const ev = (sb?.events || []).find(e => (e.competitions?.[0]?.competitors || []).some(c => isPSG(c.team?.displayName) || c.team?.id === "160"));
        if (ev) return { league, day, ev };
      }
    }
    throw new Error("match introuvable");
  }
  static status(st) {
    const name = st?.type?.name || "", state = st?.type?.state;
    if (name === "STATUS_HALFTIME") return "HT";
    if (["STATUS_POSTPONED", "STATUS_CANCELED", "STATUS_ABANDONED", "STATUS_SUSPENDED"].includes(name)) return "OFF";
    if (state === "pre") return "NS";
    if (state === "in") return "LIVE";
    if (state === "post") return "FT";
    return "OFF";
  }
  async live(fixture) {
    const { league, ev } = await this.findEvent(fixture);
    fixture.refs = { ...fixture.refs, espnLeague: league };
    const comp = ev.competitions[0];
    const home = comp.competitors.find(c => c.homeAway === "home"), away = comp.competitors.find(c => c.homeAway === "away");
    const sideOf = teamId => (teamId === home?.team?.id ? "home" : teamId === away?.team?.id ? "away" : null);
    const goals = (comp.details || [])
      .filter(d => d.scoringPlay)
      .map(d => ({
        minute: (d.clock?.displayValue || "").replace(/'/g, ""),
        side: sideOf(d.team?.id),
        player: d.athletesInvolved?.[0]?.shortName || d.athletesInvolved?.[0]?.displayName || "",
        detail: d.ownGoal ? "csc" : d.penaltyKick ? "pen" : "",
      }))
      .filter(g => g.side);
    const status = Espn.status(comp.status || ev.status);
    const clock = parseInt(comp.status?.displayClock || ev.status?.displayClock, 10);
    return { status, minute: status === "LIVE" && clock > 0 ? clock : null, homeGoals: Number(home?.score) || 0, awayGoals: Number(away?.score) || 0, goals, lineup: null };
  }
}

/* ---------------- API-Football (clé sur dashboard.api-football.com) ---------------- */
class ApiFootball {
  constructor(key, teamId = 85) {
    this.name = "api-football";
    this.key = key;
    this.teamId = Number(teamId);
    this.base = "https://v3.football.api-sports.io";
  }
  async get(path) {
    const j = await getJSON(this.base + path, { "x-apisports-key": this.key });
    // L'API répond 200 même en cas d'erreur (clé invalide, saison hors offre, quota…)
    const errs = j.errors && (Array.isArray(j.errors) ? j.errors : Object.values(j.errors));
    if (errs?.length) throw new Error(errs.join(" ; "));
    return j;
  }
  static status(short) {
    if (["NS", "TBD"].includes(short)) return "NS";
    if (short === "HT" || short === "BT") return "HT";
    if (["1H", "2H", "ET", "P", "LIVE", "INT", "SUSP"].includes(short)) return "LIVE";
    if (["FT", "AET", "PEN", "AWD", "WO"].includes(short)) return "FT";
    return "OFF";
  }
  async live(fixture) {
    let id = fixture.refs?.apiFootball;
    if (!id) {
      for (const day of matchDays(fixture.kickoff)) {
        const date = day.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
        const j = await this.get(`/fixtures?date=${date}&team=${this.teamId}&timezone=UTC`);
        if (j.response?.[0]) { id = j.response[0].fixture.id; break; }
      }
      if (!id) throw new Error("match introuvable");
      fixture.refs = { ...fixture.refs, apiFootball: id };
    }
    const r = (await this.get(`/fixtures?id=${id}`)).response?.[0];
    if (!r) throw new Error("match introuvable");
    const homeId = r.teams.home.id;
    const goals = (r.events || [])
      .filter(e => e.type === "Goal" && e.detail !== "Missed Penalty")
      .map(e => ({
        minute: e.time.extra ? `${e.time.elapsed}+${e.time.extra}` : String(e.time.elapsed),
        side: e.team.id === homeId ? "home" : "away",
        player: e.player?.name || "",
        detail: e.detail === "Own Goal" ? "csc" : e.detail === "Penalty" ? "pen" : "",
      }));
    const mine = (r.lineups || []).find(t => t.team.id === this.teamId);
    return {
      status: ApiFootball.status(r.fixture.status.short),
      minute: r.fixture.status.elapsed,
      homeGoals: r.goals.home ?? 0,
      awayGoals: r.goals.away ?? 0,
      goals,
      lineup: mine?.startXI?.length ? { formation: mine.formation, players: mine.startXI.map(p => p.player.name) } : null,
    };
  }
}

/* ---------------- Sofascore (API non officielle, sans clé) ---------------- */
class Sofascore {
  constructor() {
    this.name = "sofascore";
    this.base = "https://api.sofascore.com/api/v1";
  }
  get(path) { return getJSON(this.base + path, { Referer: "https://www.sofascore.com/", Origin: "https://www.sofascore.com" }); }
  static status(type) {
    return { notstarted: "NS", inprogress: "LIVE", finished: "FT", postponed: "OFF", canceled: "OFF" }[type] || "OFF";
  }
  async live(fixture) {
    const id = fixture.refs?.sofascore;
    if (!id) throw new Error("identifiant Sofascore absent de data.json");
    const [ev, inc, lu] = await Promise.allSettled([this.get(`/event/${id}`), this.get(`/event/${id}/incidents`), this.get(`/event/${id}/lineups`)]);
    if (ev.status !== "fulfilled") throw ev.reason;
    const e = ev.value.event;
    let status = Sofascore.status(e.status?.type);
    if (status === "LIVE" && e.status?.code === 31) status = "HT";
    let minute = null;
    const start = e.time?.currentPeriodStartTimestamp;
    if (status === "LIVE" && start) {
      const offset = e.status?.code === 7 ? 45 : e.status?.code === 41 ? 90 : e.status?.code === 42 ? 105 : 0;
      minute = Math.max(1, Math.floor((Date.now() / 1000 - start) / 60) + 1 + offset);
    }
    const incidents = inc.status === "fulfilled" ? inc.value.incidents || [] : [];
    const goals = incidents
      .filter(i => i.incidentType === "goal")
      .map(i => ({
        minute: i.addedTime ? `${i.time}+${i.addedTime}` : String(i.time),
        side: i.isHome ? "home" : "away",
        player: i.player?.shortName || i.player?.name || i.playerName || "",
        detail: i.incidentClass === "ownGoal" ? "csc" : i.incidentClass === "penalty" ? "pen" : "",
      }))
      .reverse();
    let lineup = null;
    if (lu.status === "fulfilled" && lu.value.confirmed) {
      const side = isPSG(e.homeTeam?.name) ? lu.value.home : lu.value.away;
      const xi = (side?.players || []).filter(p => !p.substitute).map(p => p.player?.shortName || p.player?.name);
      if (xi.length >= 11) lineup = { formation: side.formation || "", players: xi };
    }
    return { status, minute, homeGoals: e.homeScore?.current ?? 0, awayGoals: e.awayScore?.current ?? 0, goals, lineup };
  }
}

/* ---------------- Chaîne : la première source qui répond l'emporte ---------------- */
class ProviderChain {
  constructor(providers) {
    this.providers = providers;
    this.name = providers.map(p => p.name).join(" → ");
    this.health = Object.fromEntries(providers.map(p => [p.name, { ok: null, lastError: null, at: null }]));
    this.used = null;
  }
  async live(fixture) {
    const errors = [];
    for (const p of this.providers) {
      try {
        const r = await p.live(fixture);
        this.health[p.name] = { ok: true, lastError: null, at: new Date().toISOString() };
        // Une source qui ne connaît pas encore la compo n'empêche pas une autre de la fournir plus tard.
        this.used = p.name;
        return r;
      } catch (e) {
        this.health[p.name] = { ok: false, lastError: e.message, at: new Date().toISOString() };
        errors.push(`${p.name} : ${e.message}`);
      }
    }
    throw new Error("Aucune source de score ne répond (" + errors.join(" | ") + ")");
  }
}

function createProvider() {
  // API-Football en dernier : l'offre gratuite est limitée à 100 requêtes par jour.
  const list = [new Espn(), new Sofascore()];
  if (process.env.API_FOOTBALL_KEY) list.push(new ApiFootball(process.env.API_FOOTBALL_KEY, process.env.API_FOOTBALL_TEAM_ID || 85));
  return new ProviderChain(list);
}

// Construit le match à suivre à partir de data.json.
function fixtureFromData(data) {
  const m = data?.nextMatch;
  const kickoff = m?.kickoff ? Date.parse(m.kickoff) : NaN;
  if (!m || !m.home || !m.away || isNaN(kickoff) || m.kickoff.length <= 10) return null;
  return {
    id: `${kickoff}-${m.home}-${m.away}`.replace(/\s+/g, "_"),
    kickoff, home: m.home, away: m.away, competition: m.competition || "",
    refs: m.sofascoreId ? { sofascore: Number(m.sofascoreId) } : {},
  };
}

module.exports = { createProvider, fixtureFromData, ProviderChain, Espn, ApiFootball, Sofascore };
