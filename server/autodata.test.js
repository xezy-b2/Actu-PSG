const test = require("node:test");
const assert = require("node:assert");
const { buildMatches, buildStandings, parseRss, categorize, cleanTeam } = require("./autodata");
const { mergeData } = require("./merge");

const NOW = Date.parse("2026-10-11T10:00:00Z");
const fd = (id, date, home, away, status, hs, as, code = "FL1", md = 6) => ({ id, utcDate: date, status, matchday: md, competition: { code, name: code === "CL" ? "UEFA Champions League" : "Ligue 1" }, homeTeam: { name: home }, awayTeam: { name: away }, score: { fullTime: { home: hs, away: as } }, referees: [{ name: "M. Vernice", type: "REFEREE" }], venue: "Parc des Princes" });
const matches = [
  fd(1, "2026-09-20T18:45:00Z", "Olympique de Marseille", "Paris Saint-Germain FC", "FINISHED", 1, 2, "FL1", 5),
  fd(2, "2026-10-10T18:45:00Z", "Paris Saint-Germain FC", "Le Mans FC", "FINISHED", 3, 1, "FL1", 6),
  fd(3, "2026-10-14T19:00:00Z", "Manchester City FC", "Paris Saint-Germain FC", "TIMED", null, null, "CL", 2),
  fd(4, "2026-10-17T15:15:00Z", "RC Strasbourg Alsace", "Paris Saint-Germain FC", "TIMED", null, null, "FL1", 7),
  fd(5, "2026-11-28T00:00:00Z", "Paris Saint-Germain FC", "FC Lorient", "SCHEDULED", null, null, "FL1", 14),
];

test("matchs : résultats, prochain match et calendrier", () => {
  const r = buildMatches(matches, NOW);
  assert.equal(r.results[0].home, "Paris Saint-Germain");
  assert.deepEqual([r.results[0].hs, r.results[0].as, r.results[0].competition], [3, 1, "Ligue 1 · J6"]);
  assert.equal(r.nextMatch.home, "Manchester City");
  assert.equal(r.nextMatch.competition, "Ligue des champions");
  assert.equal(r.nextMatch.status, "scheduled");
  assert.equal(r.fixtures[0].home, "RC Strasbourg Alsace");
  assert.equal(r.fixtures[1].date, "2026-11-28"); // date sans heure confirmée
  // Le soir du match, juste après la fin : on garde le score final affiché.
  const after = buildMatches(matches, Date.parse("2026-10-10T21:00:00Z"));
  assert.equal(after.nextMatch.away, "Le Mans");
  assert.equal(after.nextMatch.status, "final");
  assert.deepEqual(after.nextMatch.score, { home: 3, away: 1 });
});

test("noms d'équipes nettoyés", () => {
  assert.equal(cleanTeam("Stade Rennais FC 1901"), "Stade Rennais");
  assert.equal(cleanTeam("Paris Saint-Germain FC"), "Paris Saint-Germain");
  assert.equal(cleanTeam("FC Lorient"), "FC Lorient");
  assert.equal(cleanTeam("Paris FC"), "Paris FC");
  assert.equal(cleanTeam("Le Havre AC"), "Le Havre");
  assert.equal(cleanTeam("Toulouse FC"), "Toulouse");
});

test("classement", () => {
  const s = buildStandings({ standings: [{ type: "TOTAL", table: [{ position: 1, team: { name: "Lille OSC" }, playedGames: 6, won: 4, draw: 1, lost: 1, points: 13 }] }] });
  assert.deepEqual(s[0], { rank: 1, team: "Lille OSC", w: 4, d: 1, l: 1, pts: 13, played: 6 });
});

test("flux RSS et catégories", () => {
  const xml = `<rss><channel><item><title><![CDATA[Mercato : le PSG prolonge Zaïre-Emery]]></title><link>https://www.footmercato.net/a1</link><pubDate>Sun, 11 Oct 2026 09:00:00 +0200</pubDate><category><![CDATA[PSG]]></category></item>
  <item><title>Hakimi forfait contre City &amp; Strasbourg</title><link>https://ex.fr/b</link><pubDate>Sun, 11 Oct 2026 08:00:00 GMT</pubDate><source url="https://ex.fr">Le Parisien</source></item></channel></rss>`;
  const items = parseRss(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Mercato : le PSG prolonge Zaïre-Emery");
  assert.deepEqual(items[0].categories, ["PSG"]);
  assert.equal(items[1].title, "Hakimi forfait contre City & Strasbourg");
  assert.equal(items[1].source, "Le Parisien");
  assert.equal(categorize(items[0].title), "mercato");
  assert.equal(categorize(items[1].title), "infirmerie");
});

test("fusion : infos rédigées gardées pour le même match, score en direct par-dessus", () => {
  const base = { nextMatch: { home: "Manchester City", away: "Paris Saint-Germain", kickoff: "2026-10-14T19:00:00Z", tv: "Canal+", sofascoreId: 42 }, lineup: { lines: [["Safonov"]] }, absents: [{ name: "X" }], news: [{ id: "a", title: "Article rédigé", publishedAt: "2026-10-11T08:00:00Z" }] };
  const auto = { ...buildMatches(matches, NOW), news: [{ id: "rss-1", title: "Titre RSS", url: "https://x/1", publishedAt: "2026-10-11T09:00:00Z" }] };
  let out = mergeData(base, auto, null, NOW);
  assert.equal(out.nextMatch.tv, "Canal+");
  assert.equal(out.nextMatch.sofascoreId, 42);
  assert.ok(out.lineup);
  assert.deepEqual(out.news.map(n => n.title), ["Titre RSS", "Article rédigé"]);
  assert.equal(out.results[0].away, "Le Mans");

  const live = { fixture: { home: "Manchester City", away: "Paris Saint-Germain", kickoff: "2026-10-14T19:00:00.000Z" }, at: Date.parse("2026-10-14T19:30:00Z"), live: { status: "LIVE", minute: 30, homeGoals: 0, awayGoals: 1, goals: [{ side: "away", player: "Doué", minute: "28", detail: "" }] } };
  out = mergeData(base, auto, live, Date.parse("2026-10-14T19:31:00Z"));
  assert.equal(out.nextMatch.status, "live");
  assert.deepEqual(out.nextMatch.score, { home: 0, away: 1 });
  assert.equal(out.nextMatch.events[0].text, "But de Doué · Paris Saint-Germain");

  // Match différent dans data.json (données rédigées en retard) : on n'affiche pas une vieille compo.
  const stale = { ...base, nextMatch: { home: "Paris Saint-Germain", away: "Le Mans FC", kickoff: "2026-10-10T18:45:00Z", sofascoreId: 7 } };
  out = mergeData(stale, auto, null, NOW);
  assert.equal(out.nextMatch.home, "Manchester City");
  assert.equal(out.nextMatch.sofascoreId, undefined);
  assert.equal(out.lineup, null);
});
