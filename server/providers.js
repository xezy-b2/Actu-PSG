// Sources de scores en direct, ramenées à un format commun.
//
// Fixture : { id, kickoff (ms), home, away, competition }
// Live    : { status: "NS" | "LIVE" | "HT" | "FT" | "OFF", minute, homeGoals, awayGoals,
//             goals: [{ key, minute, side: "home" | "away", player, detail }],
//             lineup: null | { formation, players: [noms du XI du PSG] } }

const UA = "Mozilla/5.0 (compatible; ActuPSG/1.0; +https://github.com/xezy-b2/actu-psg)";

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} sur ${url}`);
  return res.json();
}

/* ---------------- API-Football (clé gratuite sur dashboard.api-football.com) ---------------- */
class ApiFootball {
  constructor(key, teamId = 85) {
    this.name = "api-football";
    this.key = key;
    this.teamId = Number(teamId);
    this.base = "https://v3.football.api-sports.io";
    this.defaultPollSeconds = 120; // offre gratuite : 100 requêtes par jour
  }
  get(path) { return getJSON(this.base + path, { "x-apisports-key": this.key }); }
  static status(short) {
    if (["NS", "TBD"].includes(short)) return "NS";
    if (short === "HT" || short === "BT") return "HT";
    if (["1H", "2H", "ET", "P", "LIVE", "INT", "SUSP"].includes(short)) return "LIVE";
    if (["FT", "AET", "PEN", "AWD", "WO"].includes(short)) return "FT";
    return "OFF"; // PST, CANC, ABD
  }
  toFixture(r) {
    return { id: String(r.fixture.id), kickoff: new Date(r.fixture.date).getTime(), home: r.teams.home.name, away: r.teams.away.name, competition: r.league?.name || "", status: ApiFootball.status(r.fixture.status.short) };
  }
  async currentOrNext() {
    const [last, next] = await Promise.all([this.get(`/fixtures?team=${this.teamId}&last=1`), this.get(`/fixtures?team=${this.teamId}&next=1`)]);
    const l = last.response?.[0] && this.toFixture(last.response[0]);
    const n = next.response?.[0] && this.toFixture(next.response[0]);
    return pickCurrent(l, n);
  }
  async live(fixture) {
    const data = await this.get(`/fixtures?id=${fixture.id}`);
    const r = data.response?.[0];
    if (!r) throw new Error("Match introuvable chez API-Football");
    const homeId = r.teams.home.id;
    const goals = (r.events || [])
      .filter(e => e.type === "Goal" && e.detail !== "Missed Penalty")
      .map(e => ({
        key: `${e.time.elapsed}+${e.time.extra || 0}-${e.team.id}-${e.player?.name || "?"}`,
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
  constructor(teamId = 1644) {
    this.name = "sofascore";
    this.teamId = Number(teamId);
    this.base = "https://api.sofascore.com/api/v1";
    this.defaultPollSeconds = 30;
  }
  get(path) { return getJSON(this.base + path, { Referer: "https://www.sofascore.com/", Origin: "https://www.sofascore.com" }); }
  static status(type) {
    return { notstarted: "NS", inprogress: "LIVE", finished: "FT", postponed: "OFF", canceled: "OFF" }[type] || "OFF";
  }
  toFixture(e) {
    return { id: String(e.id), kickoff: e.startTimestamp * 1000, home: e.homeTeam.name, away: e.awayTeam.name, competition: e.tournament?.uniqueTournament?.name || e.tournament?.name || "", status: Sofascore.status(e.status?.type) };
  }
  async currentOrNext() {
    const [last, next] = await Promise.allSettled([this.get(`/team/${this.teamId}/events/last/0`), this.get(`/team/${this.teamId}/events/next/0`)]);
    const lastEvents = last.status === "fulfilled" ? last.value.events || [] : [];
    const nextEvents = next.status === "fulfilled" ? next.value.events || [] : [];
    if (!lastEvents.length && !nextEvents.length) throw new Error("Sofascore ne répond pas");
    const l = lastEvents.length ? this.toFixture(lastEvents[lastEvents.length - 1]) : null;
    const n = nextEvents.length ? this.toFixture(nextEvents[0]) : null;
    return pickCurrent(l, n);
  }
  async live(fixture) {
    const [ev, inc, lu] = await Promise.allSettled([this.get(`/event/${fixture.id}`), this.get(`/event/${fixture.id}/incidents`), this.get(`/event/${fixture.id}/lineups`)]);
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
        key: `${i.time}+${i.addedTime || 0}-${i.isHome ? "h" : "a"}-${i.player?.name || i.playerName || "?"}`,
        minute: i.addedTime ? `${i.time}+${i.addedTime}` : String(i.time),
        side: i.isHome ? "home" : "away",
        player: i.player?.shortName || i.player?.name || i.playerName || "",
        detail: i.incidentClass === "ownGoal" ? "csc" : i.incidentClass === "penalty" ? "pen" : "",
      }))
      .reverse();
    let lineup = null;
    if (lu.status === "fulfilled" && lu.value.confirmed) {
      const side = e.homeTeam?.id === this.teamId ? lu.value.home : lu.value.away;
      const xi = (side?.players || []).filter(p => !p.substitute).map(p => p.player?.shortName || p.player?.name);
      if (xi.length >= 11) lineup = { formation: side.formation || "", players: xi };
    }
    return { status, minute, homeGoals: e.homeScore?.current ?? 0, awayGoals: e.awayScore?.current ?? 0, goals, lineup };
  }
}

// Le match "courant" : celui en cours, ou fini depuis moins de 3 h, sinon le prochain.
function pickCurrent(last, next) {
  const now = Date.now();
  if (last && (last.status === "LIVE" || last.status === "HT" || (last.status === "FT" && now - last.kickoff < 5 * 3600e3))) return last;
  return next || last || null;
}

function createProvider() {
  if (process.env.API_FOOTBALL_KEY) return new ApiFootball(process.env.API_FOOTBALL_KEY, process.env.API_FOOTBALL_TEAM_ID || 85);
  return new Sofascore(process.env.SOFASCORE_TEAM_ID || 1644);
}

module.exports = { createProvider, ApiFootball, Sofascore, pickCurrent };
