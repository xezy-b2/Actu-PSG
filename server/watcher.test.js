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

const { Watcher } = require("./watcher");
const { MemoryStore } = require("./store");
const { ProviderChain, Espn, fixtureFromData } = require("./providers");

test("le veilleur suit le match de data.json et bascule de source en cas d'échec", async () => {
  const kickoff = new Date(Date.now() - 20 * 60e3).toISOString();
  const data = { nextMatch: { home: "Paris Saint-Germain", away: "Le Mans FC", kickoff, sofascoreId: 1 } };
  let score = 0;
  const broken = { name: "sofascore", live: async () => { throw new Error("403 Forbidden"); } };
  const ok = { name: "espn", live: async () => ({ status: "LIVE", minute: 20, homeGoals: score, awayGoals: 0, goals: score ? [{ side: "home", player: "Doué", minute: "19", detail: "" }] : [], lineup: null }) };
  const sent = [];
  const w = new Watcher({ store: new MemoryStore(), provider: new ProviderChain([broken, ok]), notify: async (pref, p) => sent.push(p.title), getFixture: () => fixtureFromData(data) });
  await w.tick(); w.stop();            // calage en plein match, sans notification
  assert.equal(sent.length, 0);
  assert.equal(w.status.source, "espn");
  score = 1;
  await w.tick(); w.stop();
  assert.deepEqual(sent, ["But du PSG !"]);
  assert.equal(w.status.sources.sofascore.ok, false);
});

test("toutes les sources en panne : nouvel essai rapide, pas de sommeil de 6 h", async () => {
  const data = { nextMatch: { home: "Paris Saint-Germain", away: "Le Mans FC", kickoff: new Date(Date.now() - 5 * 60e3).toISOString() } };
  const w = new Watcher({ store: new MemoryStore(), provider: new ProviderChain([{ name: "x", live: async () => { throw new Error("down"); } }]), notify: async () => {}, getFixture: () => fixtureFromData(data) });
  await w.tick(); w.stop();
  assert.match(w.status.lastError, /down/);
  assert.ok(new Date(w.status.nextCheck) - Date.now() <= 61e3);
});

test("lecture du format ESPN", async () => {
  const espn = new Espn();
  espn.findEvent = async () => ({ league: "fra.1", ev: { competitions: [{
    status: { displayClock: "67'", type: { name: "STATUS_SECOND_HALF", state: "in" } },
    competitors: [{ homeAway: "home", score: "2", team: { id: "160", displayName: "Paris Saint-Germain" } }, { homeAway: "away", score: "1", team: { id: "2697", displayName: "Le Mans" } }],
    details: [
      { scoringPlay: true, clock: { displayValue: "12'" }, team: { id: "160" }, athletesInvolved: [{ displayName: "Désiré Doué" }] },
      { scoringPlay: false, clock: { displayValue: "30'" }, team: { id: "2697" }, yellowCard: true },
      { scoringPlay: true, penaltyKick: true, clock: { displayValue: "45'+2'" }, team: { id: "2697" }, athletesInvolved: [{ displayName: "H. Diallo" }] },
      { scoringPlay: true, clock: { displayValue: "61'" }, team: { id: "160" }, athletesInvolved: [{ displayName: "Ousmane Dembélé" }] },
    ] }] } });
  const r = await espn.live({ kickoff: Date.now(), refs: {} });
  assert.equal(r.status, "LIVE"); assert.equal(r.minute, 67);
  assert.deepEqual([r.homeGoals, r.awayGoals], [2, 1]);
  assert.deepEqual(r.goals.map(g => `${g.side} ${g.player} ${g.minute} ${g.detail}`), ["home Désiré Doué 12 ", "away H. Diallo 45+2 pen", "home Ousmane Dembélé 61 "]);
});
