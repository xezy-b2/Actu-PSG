const test = require("node:test");
const assert = require("node:assert");
const { diffLive, newState } = require("./watcher");

const f = { id: "1", home: "Paris Saint-Germain", away: "Le Mans", kickoff: Date.now() };
const live = (o) => ({ status: "LIVE", minute: 10, homeGoals: 0, awayGoals: 0, goals: [], lineup: null, ...o });

test("déroulé complet d'un match", () => {
  let s = newState(f), r;
  r = diffLive(s, f, live({ status: "NS" })); s = r.state;
  assert.equal(r.notifications.length, 0);

  r = diffLive(s, f, live({ status: "NS", lineup: { formation: "4-3-3", players: ["Safonov", "Hakimi"] } })); s = r.state;
  assert.deepEqual(r.notifications.map(n => n.payload.title), ["Compo officielle du PSG"]);

  r = diffLive(s, f, live({ minute: 1 })); s = r.state;
  assert.deepEqual(r.notifications.map(n => n.payload.title), ["Coup d'envoi"]);

  r = diffLive(s, f, live({ minute: 23, homeGoals: 1, goals: [{ side: "home", player: "Dembélé", minute: "23", detail: "" }] })); s = r.state;
  assert.equal(r.notifications.length, 1);
  assert.equal(r.notifications[0].payload.title, "But du PSG !");
  assert.equal(r.notifications[0].payload.body, "PSG 1-0 Le Mans · Dembélé 23'");

  // même état : rien
  r = diffLive(s, f, live({ minute: 25, homeGoals: 1, goals: [{ side: "home", player: "Dembélé", minute: "23" }] })); s = r.state;
  assert.equal(r.notifications.length, 0);

  // deux buts entre deux relevés, dont un pour l'adversaire, sans nom de buteur pour l'un
  r = diffLive(s, f, live({ minute: 40, homeGoals: 2, awayGoals: 1, goals: [{ side: "home", player: "Dembélé", minute: "23" }, { side: "away", player: "Diallo", minute: "35", detail: "pen" }, { side: "home", player: "Doué", minute: "39" }] })); s = r.state;
  assert.deepEqual(r.notifications.map(n => n.payload.body), ["PSG 2-1 Le Mans · Doué 39'", "PSG 2-1 Le Mans · Diallo 35' (pen.)"]);
  assert.equal(r.notifications[1].payload.title, "But de Le Mans");

  r = diffLive(s, f, live({ status: "HT", homeGoals: 2, awayGoals: 1, goals: [] })); s = r.state;
  assert.deepEqual(r.notifications.map(n => n.payload.title), ["Mi-temps"]);

  // but refusé par la VAR
  r = diffLive(s, f, live({ homeGoals: 2, awayGoals: 0, goals: [] })); s = r.state;
  assert.deepEqual(r.notifications.map(n => n.payload.title), ["But refusé"]);

  r = diffLive(s, f, live({ status: "FT", homeGoals: 2, awayGoals: 0 })); s = r.state;
  assert.deepEqual(r.notifications.map(n => n.payload.title), ["Fin du match · Victoire du PSG"]);
  r = diffLive(s, f, live({ status: "FT", homeGoals: 2, awayGoals: 0 }));
  assert.equal(r.notifications.length, 0);
});

test("redémarrage en plein match : aucune notification rétroactive", () => {
  const r = diffLive(newState(f), f, live({ minute: 60, homeGoals: 3, goals: [{ side: "home" }, { side: "home" }, { side: "home" }] }));
  assert.equal(r.notifications.length, 0);
  assert.deepEqual(r.state.score, [3, 0]);
  const r2 = diffLive(r.state, f, live({ minute: 70, homeGoals: 3, awayGoals: 1, goals: [] }));
  assert.equal(r2.notifications[0].payload.title, "But de Le Mans");
  assert.equal(r2.notifications[0].payload.body, "PSG 3-1 Le Mans · 70'");
});

test("PSG à l'extérieur : défaite bien libellée", () => {
  const away = { id: "2", home: "Manchester City", away: "Paris Saint-Germain", kickoff: Date.now() };
  let s = { ...newState(away), seen: true, score: [0, 0], sent: { lineup: true, kickoff: true, ht: true, ft: false } };
  const r = diffLive(s, away, live({ status: "FT", homeGoals: 2, awayGoals: 1 }));
  assert.equal(r.notifications.at(-1).payload.title, "Fin du match · Défaite du PSG");
  assert.equal(r.notifications[0].payload.title, "But de Manchester City");
});
