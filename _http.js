// Shared request plumbing: CORS (the Chrome extension calls these), input checks,
// a tiny in-memory TTL cache with in-flight de-duplication, JSON replies.
const b58 = require('./_b58');

const store = new Map();
const inflight = new Map();
function cacheGet(k) {
  const e = store.get(k);
  if (!e) return undefined;
  if (e.exp < Date.now()) { store.delete(k); return undefined; }
  return e.v;
}
function cacheSet(k, v, ttlMs) {
  if (store.size > 800) store.delete(store.keys().next().value);
  store.set(k, { v, exp: Date.now() + ttlMs });
}
async function memo(k, ttlMs, fn) {
  const hit = cacheGet(k);
  if (hit !== undefined) return hit;
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    try { const v = await fn(); cacheSet(k, v, ttlMs); return v; }
    finally { inflight.delete(k); }
  })();
  inflight.set(k, p);
  return p;
}

class BadRequest extends Error { constructor(m, status = 400) { super(m); this.status = status; this.publicMessage = m; } }

function requireAddress(v, name = 'ca') {
  const s = String(v || '').trim();
  if (!b58.isAddress(s)) throw new BadRequest(`"${name}" must be a Solana address`);
  return s;
}

function send(res, status, body, cacheSecs) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', status === 200 && cacheSecs ? `public, max-age=0, s-maxage=${cacheSecs}, stale-while-revalidate=${cacheSecs * 2}` : 'no-store');
  res.end(JSON.stringify(body));
}

function handler(fn) {
  return async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'GET only' });
    if (!process.env.HELIUS_API_KEY) return send(res, 503, { ok: false, error: 'HELIUS_API_KEY is not set on the server' });
    const query = req.query || Object.fromEntries(new URL(req.url, 'http://local').searchParams);
    try {
      const { body, cache } = await fn(query, req);
      send(res, 200, body, cache);
    } catch (e) {
      const status = e.status || 502;
      send(res, status, { ok: false, error: e.publicMessage || ('internal error: ' + String(e.message || e).slice(0, 120)) });
    }
  };
}

module.exports = { handler, memo, cacheGet, cacheSet, requireAddress, BadRequest, send };
