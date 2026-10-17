// Compo probable, infirmerie et rumeurs de mercato rédigées par Claude via l'API Anthropic.
// Inactif tant que ANTHROPIC_API_KEY n'est pas défini.
const API = "https://api.anthropic.com/v1/messages";

const SYSTEM = `Tu tiens à jour, pour un site de supporters, trois rubriques sur le Paris Saint-Germain (football masculin) : la composition probable du prochain match, l'infirmerie (blessés, suspendus, incertains) et les rumeurs de mercato.
Règles :
- N'utilise que des informations confirmées par les sources fournies ou par tes recherches web récentes. N'invente rien. Dans le doute, laisse de côté.
- Reformule toujours avec tes propres mots, en français. Aucune citation d'article.
- Les noms de joueurs doivent être écrits comme dans la liste de l'effectif fournie.
- Réponds uniquement par un objet JSON valide, sans texte autour.`;

const FORMAT = `Format JSON attendu :
{
  "lineup": null ou {
    "formation": "4-3-3",
    "official": false,
    "lines": [["Gardien"], ["Arrière gauche", "Défenseur central", "Défenseur central", "Arrière droit"], ["Milieu gauche", "Milieu", "Milieu droit"], ["Ailier gauche", "Avant-centre", "Ailier droit"]],
    "note": "une phrase sur les choix incertains",
    "source": "nom du ou des médias"
  },
  "absents": [{ "name": "Nom du joueur", "status": "out" | "doubt" | "suspended", "reason": "cause courte et durée si connue", "source": "média" }],
  "transfers": { "rumors": ["une phrase par rumeur sérieuse, 4 au maximum, avec le média entre parenthèses"] }
}
"lines" va du gardien vers l'attaque, chaque ligne de gauche à droite vue depuis le but parisien, 11 joueurs au total. "official": true seulement si le club a publié la composition. Mets "lineup": null si tu n'as pas d'information fiable.`;

function extractJSON(text) {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("réponse sans JSON");
  return JSON.parse(text.slice(start, end + 1));
}

const clip = (s, n = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// Vérifie et nettoie la réponse ; lève une erreur si elle est inutilisable.
function validate(j) {
  const out = {};
  if (j.lineup && Array.isArray(j.lineup.lines)) {
    const lines = j.lineup.lines.map(l => (Array.isArray(l) ? l.map(x => clip(x, 40)).filter(Boolean) : [])).filter(l => l.length);
    const count = lines.reduce((n, l) => n + l.length, 0);
    if (count === 11 && lines[0].length === 1) {
      out.lineup = { formation: clip(j.lineup.formation, 12), official: !!j.lineup.official, lines, note: clip(j.lineup.note, 240), source: clip(j.lineup.source, 80) };
    }
  }
  out.absents = (Array.isArray(j.absents) ? j.absents : []).slice(0, 15)
    .filter(a => a && a.name)
    .map(a => ({ name: clip(a.name, 40), status: ["out", "doubt", "suspended"].includes(a.status) ? a.status : "doubt", reason: clip(a.reason, 120), source: clip(a.source, 60) }));
  const rumors = Array.isArray(j.transfers?.rumors) ? j.transfers.rumors.map(r => clip(r, 220)).filter(Boolean).slice(0, 4) : [];
  out.transfers = { rumors };
  return out;
}

class Editorial {
  constructor({ apiKey, model, maxSearches, store, getContext, intervalHours }) {
    this.apiKey = apiKey;
    this.model = model || "claude-haiku-5-5";
    this.maxSearches = Number(maxSearches) || 3;
    this.intervalMs = (Number(intervalHours) || 3) * 3600e3;
    this.store = store;
    this.getContext = getContext;
    this.data = null;
    this.useSearch = true;
    this.status = { enabled: !!apiKey, model: this.model, lastRun: null, lastError: null, searches: 0, runs: 0 };
  }
  async start(onChange) {
    this.onChange = onChange;
    try { this.data = await this.store?.getKV("editorial"); } catch (e) {}
    if (this.data) onChange?.();
    if (!this.apiKey) return;
    const loop = async () => {
      if (this.due()) await this.run().catch(e => { this.status.lastError = e.message; console.warn("[editorial]", e.message); });
      setTimeout(loop, 10 * 60e3).unref?.();
    };
    setTimeout(loop, 20000);
  }
  // Toutes les 3 h ; toutes les heures dans les 8 h avant un match ; toutes les 20 min autour du coup d'envoi (compo officielle).
  due(now = Date.now()) {
    const last = this.status.lastRun ? Date.parse(this.status.lastRun) : (this.data?.updatedAt ? Date.parse(this.data.updatedAt) : 0);
    const ko = Date.parse(this.getContext()?.nextMatch?.kickoff || "");
    const until = ko - now;
    let every = this.intervalMs;
    if (until > 0 && until < 8 * 3600e3) every = 3600e3;
    if (until > -15 * 60e3 && until < 75 * 60e3 && !(this.data?.lineup?.official && this.data?.forMatchKickoff === this.getContext()?.nextMatch?.kickoff)) every = 20 * 60e3;
    return now - last >= every;
  }
  async call(body) {
    const res = await fetch(API, {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(j.error?.message || `${res.status} ${res.statusText}`); err.status = res.status; throw err; }
    return j;
  }
  async run() {
    this.status.lastRun = new Date().toISOString();
    const ctx = this.getContext() || {};
    const m = ctx.nextMatch;
    const context = {
      maintenant: new Date().toISOString(),
      prochainMatch: m ? { domicile: m.home, exterieur: m.away, coupEnvoi: m.kickoff, competition: m.competition } : null,
      effectif: (ctx.squad || []).map(p => `${p.name}${p.jersey ? " (" + p.jersey + ")" : ""}`),
      titresRecents: (ctx.news || []).slice(0, 30).map(n => `${n.publishedAt} · ${n.source || ""} · ${n.title}`),
      versionPrecedente: this.data ? { lineup: this.data.lineup || null, absents: this.data.absents || [], rumors: this.data.transfers?.rumors || [] } : null,
    };
    const body = {
      model: this.model,
      max_tokens: 2500,
      system: SYSTEM,
      messages: [{ role: "user", content: `Contexte (données du site) :\n${JSON.stringify(context, null, 1)}\n\n${this.useSearch ? `Fais au plus ${this.maxSearches} recherches web ciblées (compo probable ou officielle du prochain match, blessés et suspendus du PSG, mercato), puis mets à jour les trois rubriques.` : "Mets à jour les trois rubriques à partir des titres fournis et de la version précédente."}\n\n${FORMAT}` }],
    };
    if (this.useSearch) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: this.maxSearches }];
    let resp;
    try {
      resp = await this.call(body);
    } catch (e) {
      // Recherche web refusée (désactivée dans la console, ou modèle non compatible) : on continue sans.
      if (this.useSearch && e.status === 400 && /tool|search/i.test(e.message)) {
        this.useSearch = false; delete body.tools;
        body.messages[0].content = body.messages[0].content.replace(/Fais au plus[^\n]*/, "Mets à jour les trois rubriques à partir des titres fournis et de la version précédente.");
        resp = await this.call(body);
      } else throw e;
    }
    const text = (resp.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    const clean = validate(extractJSON(text));
    this.status.searches += resp.usage?.server_tool_use?.web_search_requests || 0;
    this.status.runs++;
    this.status.lastError = null;
    this.status.lastUsage = resp.usage ? { input: resp.usage.input_tokens, output: resp.usage.output_tokens } : null;
    this.data = {
      ...clean,
      lineup: clean.lineup || (this.data && this.data.forMatchKickoff === m?.kickoff ? this.data.lineup : null),
      forMatch: m ? { home: m.home, away: m.away, kickoff: m.kickoff } : null,
      forMatchKickoff: m?.kickoff || null,
      updatedAt: new Date().toISOString(),
    };
    try { await this.store?.setKV("editorial", this.data); } catch (e) {}
    this.onChange?.();
  }
}

module.exports = { Editorial, validate, extractJSON };
