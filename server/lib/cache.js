// sha256(text) -> parsed object. A repeat upload must cost zero model calls.
// Mongo when it's there, an in-memory Map when it isn't. The venue wifi does
// not get a vote in whether the demo works.
import crypto from 'node:crypto';
import mongoose from 'mongoose';

const memory = new Map();
let mongoReady = false;

export const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

const ParseSchema = new mongoose.Schema(
  {
    _id: String, // `${kind}:${hash}`
    kind: { type: String, index: true },
    hash: String,
    payload: mongoose.Schema.Types.Mixed,
    created_at: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
const ParseCache = mongoose.models.ParseCache || mongoose.model('ParseCache', ParseSchema);

export async function connectMongo(uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/resume_fit') {
  if (process.env.NO_MONGO === '1') {
    console.log('[cache] NO_MONGO=1 — using in-memory Map');
    return false;
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 1500 });
    mongoReady = true;
    console.log('[cache] MongoDB connected');
  } catch (error) {
    mongoReady = false;
    console.warn(`[cache] MongoDB unreachable (${error.message.split('\n')[0]}) — using in-memory Map`);
  }
  return mongoReady;
}

export const cacheBackend = () => (mongoReady ? 'mongodb' : 'memory');

export async function cacheGet(kind, hash) {
  const key = `${kind}:${hash}`;
  if (memory.has(key)) return memory.get(key);
  if (!mongoReady) return null;
  try {
    const doc = await ParseCache.findById(key).lean();
    if (!doc) return null;
    memory.set(key, doc.payload); // warm the hot path
    return doc.payload;
  } catch (error) {
    console.warn('[cache] read failed:', error.message);
    return null;
  }
}

export async function cacheSet(kind, hash, payload) {
  const key = `${kind}:${hash}`;
  memory.set(key, payload);
  if (!mongoReady) return;
  try {
    await ParseCache.findByIdAndUpdate(
      key,
      { _id: key, kind, hash, payload, created_at: new Date() },
      { upsert: true },
    );
  } catch (error) {
    console.warn('[cache] write failed:', error.message);
  }
}

/**
 * The whole parse-once-compare-many idea in one function: hash the text, hand
 * back a cached parse if we've seen it, otherwise call produce() and store it.
 * Every caller passes a stats object so we can show cache hits on stage.
 */
export async function cachedParse(kind, text, produce, stats) {
  const hash = sha256(text);
  const hit = await cacheGet(kind, hash);
  if (hit) {
    if (stats) stats.cache_hits += 1;
    return { id: `${kind}_${hash.slice(0, 12)}`, hash, parsed: hit, cached: true };
  }
  const parsed = await produce();
  await cacheSet(kind, hash, parsed);
  return { id: `${kind}_${hash.slice(0, 12)}`, hash, parsed, cached: false };
}

export function cacheStats() {
  return { backend: cacheBackend(), memory_entries: memory.size };
}
