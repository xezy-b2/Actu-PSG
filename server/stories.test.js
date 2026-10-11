const test = require("node:test");
const assert = require("node:assert");
const { sameStory } = require("./stories");
const { DataSync } = require("./datasync");
const { MemoryStore } = require("./store");

test("même info reformulée par plusieurs médias", () => {
  assert.ok(sameStory("Hakimi forfait contre Manchester City", "PSG : Achraf Hakimi absent face à Manchester City"));
  assert.ok(sameStory("Mercato : le PSG prolonge Warren Zaïre-Emery jusqu'en 2031", "Officiel : Zaïre-Emery prolonge au PSG jusqu'en 2031"));
  assert.ok(sameStory("Banderole d'Auteuil : le PSG s'expose à des sanctions", "PSG : le club peut-il être sanctionné pour la banderole des ultras ?"));
});

test("infos différentes sur le même joueur", () => {
  assert.ok(!sameStory("Hakimi prolonge son contrat", "Hakimi blessé à la cuisse"));
  assert.ok(!sameStory("Dembélé buteur contre Lyon", "Doué élu joueur du mois"));
});

test("une seule notification par info, même reprise par 6 médias", async () => {
  const store = new MemoryStore();
  const sent = [];
  const ds = new DataSync({ localFile: "/nonexistent", store, notify: async (pref, p) => sent.push(p.body) });
  const t = new Date().toISOString();
  await ds.checkNews([{ id: "old", title: "Ancienne info", publishedAt: t }]); // premier passage : mémorise
  const titles = [
    "Hakimi forfait contre Manchester City",
    "PSG : Achraf Hakimi absent face à Manchester City",
    "Manchester City-PSG : Hakimi forfait, coup dur pour Luis Enrique",
    "Coup dur : Hakimi ne jouera pas à Manchester City",
    "Ligue des champions : Hakimi forfait pour Manchester City",
    "PSG : sans Hakimi à Manchester City",
  ];
  for (let i = 0; i < titles.length; i++) await ds.checkNews([{ id: "n" + i, title: titles[i], category: "infirmerie", publishedAt: t }]);
  assert.deepEqual(sent, ["Hakimi forfait contre Manchester City"]);
  await ds.checkNews([{ id: "x", title: "Mercato : le PSG prolonge Zaïre-Emery jusqu'en 2031", category: "mercato", publishedAt: t }]);
  assert.equal(sent.length, 2);
});

test("fil d'actu : doublons regroupés", () => {
  const { mergeData } = require("./merge");
  const out = mergeData({ news: [{ id: "a", title: "Hakimi forfait contre Manchester City", summary: "Rédigé", publishedAt: "2026-10-11T10:00:00Z" }] },
    { news: [{ id: "r1", url: "https://x/1", title: "PSG : Achraf Hakimi absent face à Manchester City", publishedAt: "2026-10-11T11:00:00Z" },
             { id: "r2", url: "https://x/2", title: "Dembélé élu joueur du mois", publishedAt: "2026-10-11T09:00:00Z" }] });
  assert.deepEqual(out.news.map(n => n.id), ["a", "r2"]);
});
