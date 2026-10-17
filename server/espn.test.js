const test = require("node:test");
const assert = require("node:assert");
const { buildSheet, buildSquad, buildScorers, eventKind } = require("./espn");
const { validate, extractJSON } = require("./editorial");
const { mergeData } = require("./merge");

// Extrait du format réel d'ESPN (Manchester City 2-4 PSG, 14/10/2026).
const summary = {
  header: { id: "401915407", competitions: [{ date: "2026-10-14T19:00Z", status: { displayClock: "90'+5'", type: { name: "STATUS_FULL_TIME", state: "post" } },
    competitors: [{ homeAway: "home", score: "2", team: { id: "382", displayName: "Manchester City" } }, { homeAway: "away", score: "4", team: { id: "160", displayName: "Paris Saint-Germain" } }] }] },
  keyEvents: [
    { type: { type: "kickoff" }, clock: { value: 0, displayValue: "0'" }, team: { id: "382" } },
    { type: { type: "goal" }, scoringPlay: true, clock: { value: 770, displayValue: "13'" }, team: { id: "160" }, participants: [{ athlete: { displayName: "Désiré Doué" } }, { athlete: { displayName: "Fabián Ruiz" } }] },
    { type: { type: "goal---header" }, scoringPlay: true, clock: { value: 869, displayValue: "15'" }, team: { id: "160" }, participants: [{ athlete: { displayName: "Ousmane Dembélé" } }, { athlete: { displayName: "Désiré Doué" } }] },
    { type: { type: "substitution" }, clock: { value: 2700, displayValue: "45'" }, team: { id: "382" }, participants: [{ athlete: { displayName: "Iliman Ndiaye" } }, { athlete: { displayName: "Jérémy Doku" } }] },
    { type: { type: "yellow-card" }, clock: { value: 4140, displayValue: "69'" }, team: { id: "160" }, participants: [{ athlete: { displayName: "Warren Zaïre-Emery" } }] },
    { type: { type: "penalty---saved" }, clock: { value: 5400, displayValue: "90'" }, team: { id: "160" }, participants: [{ athlete: { displayName: "Ferran Torres" } }] },
  ],
  boxscore: { teams: [
    { team: { id: "382" }, statistics: [{ name: "possessionPct", displayValue: "53.9" }, { name: "totalShots", displayValue: "27" }, { name: "wonCorners", displayValue: "11" }, { name: "accurateCrosses", displayValue: "10" }] },
    { team: { id: "160" }, statistics: [{ name: "possessionPct", displayValue: "46.1" }, { name: "totalShots", displayValue: "15" }, { name: "wonCorners", displayValue: "2" }] },
  ] },
  rosters: [
    { homeAway: "home", team: { id: "382" }, formation: "4-2-3-1", roster: [{ starter: true, jersey: "1", athlete: { displayName: "Gianluigi Donnarumma" }, position: { abbreviation: "G" }, formationPlace: "1" }] },
    { homeAway: "away", team: { id: "160" }, formation: "4-3-3", roster: [{ starter: true, jersey: "39", athlete: { displayName: "Matvei Safonov" }, position: { abbreviation: "G" }, formationPlace: "1" }, { starter: false, subbedIn: true, jersey: "9", athlete: { displayName: "Ferran Torres" }, position: { abbreviation: "F" } }] },
  ],
  gameInfo: { venue: { fullName: "Etihad Stadium" }, attendance: 52900 },
};

test("fiche de match ESPN", () => {
  const s = buildSheet(summary, "uefa.champions");
  assert.equal(s.status, "FT");
  assert.deepEqual([s.home.score, s.away.score], [2, 4]);
  assert.equal(s.away.formation, "4-3-3");
  assert.equal(s.home.stats.possessionPct, 53.9);
  assert.equal(s.home.stats.accurateCrosses, undefined); // stat non retenue
  assert.deepEqual(s.events.map(e => `${e.min} ${e.kind} ${e.side} ${e.player} / ${e.other}`), [
    "13 goal away Désiré Doué / Fabián Ruiz",
    "15 goal away Ousmane Dembélé / Désiré Doué",
    "45 sub home Iliman Ndiaye / Jérémy Doku",
    "69 yellow away Warren Zaïre-Emery / ",
    "90 penmiss away Ferran Torres / ",
  ]);
  assert.equal(s.away.players[1].in, true);
  assert.equal(s.venue, "Etihad Stadium");
});

test("types d'événements", () => {
  assert.equal(eventKind("own-goal"), "own");
  assert.equal(eventKind("penalty---scored"), "pen");
  assert.equal(eventKind("red-card"), "red");
  assert.equal(eventKind("halftime"), null);
});

test("effectif et buteurs", () => {
  const stat = (g, a, app) => ({ splits: { categories: [{ stats: [{ name: "totalGoals", value: g }, { name: "goalAssists", value: a }, { name: "appearances", value: app }] }] } });
  const squad = buildSquad({
    FL1: { athletes: [
      { id: "1", displayName: "Ousmane Dembélé", shortName: "O. Dembélé", jersey: "10", position: { displayName: "Forward", abbreviation: "F" }, age: 29, citizenship: "France", statistics: stat(0, 1, 4) },
      { id: "2", displayName: "Matvei Safonov", shortName: "M. Safonov", jersey: "39", position: { displayName: "Goalkeeper", abbreviation: "G" }, statistics: stat(0, 0, 6) },
    ] },
    CL: { athletes: [{ id: "1", displayName: "Ousmane Dembélé", shortName: "O. Dembélé", jersey: "10", position: { displayName: "Forward" }, statistics: stat(3, 3, 2) }] },
  });
  assert.deepEqual(squad.map(p => p.name), ["Matvei Safonov", "Ousmane Dembélé"]);
  assert.deepEqual(squad[1].stats.CL, { app: 2, goals: 3, assists: 3, yellow: 0, red: 0, subIn: 0 });
  const sc = buildScorers(squad);
  assert.equal(sc.CL.goals[0].name, "O. Dembélé");
  assert.equal(sc.FL1.goals.length, 0);
  assert.equal(sc.FL1.assists[0].assists, 1);

  const out = mergeData({ absents: [{ name: "Ousmane Dembélé", status: "doubt", reason: "Ischio" }] }, { squad, squadGroups: {} });
  assert.equal(out.squad[1].status, "doubt");
});

test("réponse de l'API Claude : validation", () => {
  const ok = validate(extractJSON(`Voici :\n{"lineup":{"formation":"4-3-3","official":false,"lines":[["Safonov"],["Mendes","Marquinhos","Pacho","Hakimi"],["Ruiz","Vitinha","Neves"],["Kvaratskhelia","Dembélé","Doué"]],"note":"x","source":"L'Équipe"},
    "absents":[{"name":"Mayulu","status":"out","reason":"cuisse"},{"name":"X","status":"bizarre"}],"transfers":{"rumors":["a","b","c","d","e"]}}`));
  assert.equal(ok.lineup.lines.flat().length, 11);
  assert.equal(ok.absents[1].status, "doubt");
  assert.equal(ok.transfers.rumors.length, 4);
  const bad = validate({ lineup: { lines: [["A"], ["B", "C"]] }, absents: "nope" });
  assert.equal(bad.lineup, undefined); // compo incomplète ignorée
  assert.deepEqual(bad.absents, []);
});

test("fusion : l'éditorial Claude remplace la compo seulement pour le bon match", () => {
  const nm = { home: "RC Strasbourg Alsace", away: "Paris Saint-Germain", kickoff: "2026-10-17T15:15:00Z", status: "scheduled" };
  const auto = { nextMatch: nm };
  const ai = { updatedAt: "2026-10-17T12:00:00Z", forMatch: nm, lineup: { lines: [["A"]] }, absents: [{ name: "B", status: "out" }], transfers: { rumors: ["r"] } };
  let out = mergeData({ transfers: { in: [1], out: [2] } }, auto, null, Date.now(), ai);
  assert.deepEqual(out.lineup, { lines: [["A"]] });
  assert.deepEqual(out.transfers, { in: [1], out: [2], rumors: ["r"] });
  out = mergeData({}, auto, null, Date.now(), { ...ai, forMatch: { home: "X", away: "Y", kickoff: "2026-10-01T00:00:00Z" } });
  assert.equal(out.lineup, undefined);
});
