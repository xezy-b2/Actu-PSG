// Veilleur de match : suit le match du PSG et prépare les notifications.
const SHORT = { "Paris Saint-Germain": "PSG", "Paris Saint Germain": "PSG", "Paris SG": "PSG" };
const short = n => SHORT[n] || n;
const isPSG = n => /paris s(ain)?t?[- ]?g|^psg$/i.test(n || "");

function newState(fixture) {
  return { fixtureId: fixture.id, seen: false, score: [0, 0], sent: { lineup: false, kickoff: false, ht: false, ft: false } };
}

function scoreLine(f, h, a) { return `${short(f.home)} ${h}-${a} ${short(f.away)}`; }

// Compare l'état précédent avec le direct et renvoie les notifications à envoyer.
// Fonction pure : facile à tester.
function diffLive(state, fixture, live) {
  const s = JSON.parse(JSON.stringify(state));
  const out = [];
  const tagBase = `match-${fixture.id}`;
  const [h, a] = [live.homeGoals ?? 0, live.awayGoals ?? 0];

  // Première observation d'un match déjà commencé (redémarrage du serveur) : on se cale sans notifier.
  if (!s.seen) {
    s.seen = true;
    if (live.status !== "NS") {
      s.score = [h, a];
      s.sent.kickoff = true;
      if (live.status === "HT") s.sent.ht = true;
      if (live.status === "FT") s.sent.ft = true;
      if (live.lineup) s.sent.lineup = true;
      return { state: s, notifications: out };
    }
  }

  if (live.lineup && !s.sent.lineup) {
    s.sent.lineup = true;
    out.push({ pref: "lineup", payload: {
      title: "Compo officielle du PSG",
      body: `${live.lineup.formation ? live.lineup.formation + " · " : ""}${live.lineup.players.join(", ")}`,
      tag: `${tagBase}-lineup`, topic: "lineup",
    } });
  }

  if ((live.status === "LIVE" || live.status === "HT" || live.status === "FT") && !s.sent.kickoff) {
    s.sent.kickoff = true;
    if (live.status === "LIVE") out.push({ pref: "match", payload: { title: "Coup d'envoi", body: `${short(fixture.home)} – ${short(fixture.away)} a commencé.`, tag: `${tagBase}-ko`, topic: "kickoff" } });
  }

  // Buts : le score fait foi, les événements servent seulement à nommer les buteurs.
  const [ph, pa] = s.score;
  const newHome = Math.max(0, h - ph), newAway = Math.max(0, a - pa);
  if (newHome || newAway) {
    // Les n derniers buts de chaque camp correspondent aux n buts nouveaux.
    const lastGoals = (side, n) => { const all = live.goals.filter(g => g.side === side); return n ? all.slice(-n) : []; };
    const goals = [
      ...Array.from({ length: newHome }, (_, i) => ({ side: "home", g: lastGoals("home", newHome)[i] })),
      ...Array.from({ length: newAway }, (_, i) => ({ side: "away", g: lastGoals("away", newAway)[i] })),
    ];
    goals.forEach(({ side, g }, i) => {
      const team = side === "home" ? fixture.home : fixture.away;
      const who = g?.player ? ` · ${g.player}${g.minute ? " " + g.minute + "'" : ""}${g.detail === "pen" ? " (pen.)" : g.detail === "csc" ? " (c.s.c.)" : ""}` : (live.minute ? ` · ${live.minute}'` : "");
      out.push({ pref: "goals", payload: {
        title: isPSG(team) ? "But du PSG !" : `But de ${short(team)}`,
        body: `${scoreLine(fixture, h, a)}${who}`,
        tag: `${tagBase}-goal-${h}-${a}-${i}`, topic: "goal",
      } });
    });
  } else if (h + a < ph + pa) {
    out.push({ pref: "goals", payload: { title: "But refusé", body: `Après vérification, le score revient à ${scoreLine(fixture, h, a)}.`, tag: `${tagBase}-var-${h}-${a}`, topic: "goal" } });
  }
  s.score = [h, a];

  if (live.status === "HT" && !s.sent.ht) {
    s.sent.ht = true;
    out.push({ pref: "match", payload: { title: "Mi-temps", body: scoreLine(fixture, h, a), tag: `${tagBase}-ht`, topic: "ht" } });
  }

  if (live.status === "FT" && !s.sent.ft) {
    s.sent.ft = true;
    const psgHome = isPSG(fixture.home);
    const us = psgHome ? h : a, them = psgHome ? a : h;
    const verdict = us > them ? "Victoire du PSG" : us === them ? "Match nul" : "Défaite du PSG";
    out.push({ pref: "match", payload: { title: `Fin du match · ${verdict}`, body: scoreLine(fixture, h, a), tag: `${tagBase}-ft`, topic: "ft" } });
  }

  return { state: s, notifications: out };
}

class Watcher {
  constructor({ store, provider, notify, pollSeconds }) {
    this.store = store;
    this.provider = provider;
    this.notify = notify;
    this.poll = (pollSeconds || provider.defaultPollSeconds) * 1000;
    this.fixture = null;
    this.nextRefresh = 0;
    this.status = { provider: provider.name, lastCheck: null, lastError: null, fixture: null, live: null };
    this.timer = null;
  }
  start() { this.schedule(2000); }
  stop() { clearTimeout(this.timer); }
  schedule(ms) {
    clearTimeout(this.timer);
    this.status.nextCheck = new Date(Date.now() + ms).toISOString();
    this.timer = setTimeout(() => this.tick().catch(e => { this.status.lastError = e.message; console.warn("[watcher]", e.message); this.schedule(5 * 60e3); }), ms);
  }
  async tick() {
    const now = Date.now();
    this.status.lastCheck = new Date(now).toISOString();
    if (!this.fixture || now >= this.nextRefresh) {
      this.fixture = await this.provider.currentOrNext();
      this.nextRefresh = now + 6 * 3600e3;
      this.status.fixture = this.fixture;
      console.log("[watcher] Match suivi :", this.fixture ? `${this.fixture.home} – ${this.fixture.away} (${new Date(this.fixture.kickoff).toISOString()})` : "aucun");
    }
    const f = this.fixture;
    if (!f || f.status === "OFF") return this.schedule(6 * 3600e3);

    let state = await this.store.getKV("match");
    if (!state || state.fixtureId !== f.id) { state = newState(f); await this.store.setKV("match", state); }

    const untilKick = f.kickoff - now;
    if (state.sent.ft || now > f.kickoff + 4 * 3600e3) {
      this.nextRefresh = 0; // match terminé : on passe au suivant
      return this.schedule(Math.max(60e3, Math.min(30 * 60e3, f.kickoff + 3 * 3600e3 - now)));
    }
    if (untilKick > 75 * 60e3) return this.schedule(Math.min(untilKick - 75 * 60e3, this.nextRefresh - now, 6 * 3600e3));

    const live = await this.provider.live(f);
    this.status.live = { ...live, goals: live.goals.length };
    this.status.lastError = null;
    const { state: next, notifications } = diffLive(state, f, live);
    await this.store.setKV("match", next);
    for (const n of notifications) await this.notify(n.pref, { ...n.payload, url: "/" }, { urgency: n.pref === "goals" ? "high" : "normal", ttl: n.pref === "goals" ? 900 : 3600 });

    if (next.sent.ft) { this.nextRefresh = Date.now() + 30 * 60e3; return this.schedule(30 * 60e3); }
    if (live.status === "NS" && untilKick > 2 * 60e3) return this.schedule(next.sent.lineup ? Math.max(60e3, untilKick - 60e3) : Math.min(10 * 60e3, Math.max(60e3, untilKick - 60e3)));
    return this.schedule(this.poll);
  }
}

module.exports = { Watcher, diffLive, newState };
