// Stockage : MongoDB si MONGODB_URI est défini, sinon mémoire (pour les tests en local).
const { MongoClient } = require("mongodb");

class MemoryStore {
  constructor() { this.subs = new Map(); this.kv = new Map(); this.kind = "memory"; }
  async init() {}
  async upsertSubscription(sub, prefs) {
    const prev = this.subs.get(sub.endpoint);
    this.subs.set(sub.endpoint, { endpoint: sub.endpoint, keys: sub.keys, prefs, createdAt: prev?.createdAt || new Date(), updatedAt: new Date() });
  }
  async getSubscription(endpoint) { return this.subs.get(endpoint) || null; }
  async removeSubscription(endpoint) { this.subs.delete(endpoint); }
  async listSubscriptions(pref) { return [...this.subs.values()].filter(s => !pref || s.prefs?.[pref]); }
  async countSubscriptions() { return this.subs.size; }
  async getKV(key) { return this.kv.get(key) ?? null; }
  async setKV(key, value) { this.kv.set(key, value); }
}

class MongoStore {
  constructor(uri, dbName) { this.uri = uri; this.dbName = dbName; this.kind = "mongodb"; }
  async init() {
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 10000 });
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.subs = this.db.collection("push_subscriptions");
    this.kvc = this.db.collection("kv");
    await this.subs.createIndex({ endpoint: 1 }, { unique: true });
  }
  async upsertSubscription(sub, prefs) {
    await this.subs.updateOne(
      { endpoint: sub.endpoint },
      { $set: { keys: sub.keys, prefs, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
  }
  async getSubscription(endpoint) { return this.subs.findOne({ endpoint }, { projection: { _id: 0 } }); }
  async removeSubscription(endpoint) { await this.subs.deleteOne({ endpoint }); }
  async listSubscriptions(pref) { return this.subs.find(pref ? { [`prefs.${pref}`]: true } : {}, { projection: { _id: 0 } }).toArray(); }
  async countSubscriptions() { return this.subs.countDocuments(); }
  async getKV(key) { const d = await this.kvc.findOne({ _id: key }); return d ? d.value : null; }
  async setKV(key, value) { await this.kvc.updateOne({ _id: key }, { $set: { value, updatedAt: new Date() } }, { upsert: true }); }
}

async function createStore() {
  const uri = process.env.MONGODB_URI;
  const store = uri ? new MongoStore(uri, process.env.MONGODB_DB || "actu_psg") : new MemoryStore();
  await store.init();
  if (!uri) console.warn("[store] MONGODB_URI absent : abonnements gardés en mémoire (perdus au redémarrage).");
  return store;
}

module.exports = { createStore, MemoryStore };
