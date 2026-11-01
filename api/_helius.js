// Helius client: JSON-RPC (single + JSON-array batches of <=20, ~1 batch/s), DAS,
// and the Enhanced Transactions API. Every call is bounded by a per-request Deadline
// so a function never runs into Vercel's 10s limit. The API key never appears in errors.
const RPC_HOST = 'https://mainnet.helius-rpc.com/';
const API_HOST = 'https://api-mainnet.helius-rpc.com';
const key = () => process.env.HELIUS_API_KEY || '';

class HeliusError extends Error {
  constructor(msg, kind) { super(msg); this.kind = kind || 'upstream'; this.publicMessage = msg; }
}

class Deadline {
  constructor(ms) { this.end = Date.now() + ms; }
  left() { return this.end - Date.now(); }
  has(ms) { return this.left() > ms; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function request(url, opts, dl, label) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    const left = dl.left() - 150;
    if (left < 350) throw last || new HeliusError(`${label}: ran out of time`, 'timeout');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(left, 7000));
    let r;
    try {
      r = await fetch(url, { ...opts, signal: ac.signal });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new HeliusError(`${label}: timed out`, 'timeout');
      last = new HeliusError(`${label}: network error`, 'network');
      await sleep(Math.min(300 * (attempt + 1), dl.left() - 500));
      continue;
    }
    clearTimeout(timer);
    if (r.status === 429 || r.status >= 500) {
      last = new HeliusError(`${label}: Helius ${r.status === 429 ? 'rate limit (429)' : 'HTTP ' + r.status}`, r.status === 429 ? 'rate' : 'upstream');
      await sleep(Math.min(450 * (attempt + 1) + Math.random() * 250, dl.left() - 500));
      continue;
    }
    if (r.status === 401 || r.status === 403) throw new HeliusError(`${label}: Helius rejected the API key (HTTP ${r.status})`, 'auth');
    let body;
    try { body = await r.json(); } catch { throw new HeliusError(`${label}: unreadable response`, 'upstream'); }
    if (!r.ok) throw new HeliusError(`${label}: HTTP ${r.status}${body && body.error ? ' ' + String(body.error.message || body.error).slice(0, 120) : ''}`, 'upstream');
    return body;
  }
  throw last;
}

const rpcUrl = () => `${RPC_HOST}?api-key=${encodeURIComponent(key())}`;
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function rpc(method, params, dl) {
  const body = await request(rpcUrl(), json({ jsonrpc: '2.0', id: 1, method, params }), dl, method);
  if (body.error) throw new HeliusError(`${method}: ${String(body.error.message || 'rpc error').slice(0, 160)}`, 'rpc');
  return body.result;
}

let nextBatchAt = 0;
// calls: [{method, params}] -> [{result} | {error}] in the same order.
async function rpcBatch(calls, dl) {
  const out = new Array(calls.length);
  for (let i = 0; i < calls.length; i += 20) {
    const chunk = calls.slice(i, i + 20);
    const wait = nextBatchAt - Date.now();
    if (wait > 0) {
      if (!dl.has(wait + 800)) { for (let j = 0; j < chunk.length; j++) out[i + j] = { error: 'ran out of time' }; continue; }
      await sleep(wait);
    }
    nextBatchAt = Date.now() + 1000;
    const payload = chunk.map((c, j) => ({ jsonrpc: '2.0', id: j, method: c.method, params: c.params }));
    let body;
    try { body = await request(rpcUrl(), json(payload), dl, `${chunk[0].method} x${chunk.length}`); }
    catch (e) { for (let j = 0; j < chunk.length; j++) out[i + j] = { error: e.publicMessage || e.message }; continue; }
    if (!Array.isArray(body)) {
      // Plan without batch support: fall back to small parallel waves.
      for (let j = 0; j < chunk.length; j += 5) {
        const wave = chunk.slice(j, j + 5);
        const res = await Promise.allSettled(wave.map((c) => rpc(c.method, c.params, dl)));
        res.forEach((r, k) => { out[i + j + k] = r.status === 'fulfilled' ? { result: r.value } : { error: r.reason.publicMessage || r.reason.message }; });
      }
      continue;
    }
    const byId = new Map(body.map((x) => [x.id, x]));
    for (let j = 0; j < chunk.length; j++) {
      const x = byId.get(j);
      out[i + j] = !x ? { error: 'missing in batch' } : x.error ? { error: String(x.error.message || 'rpc error') } : { result: x.result };
    }
  }
  return out;
}

// Enhanced Transactions API: parse up to 100 signatures per call.
async function parseTransactions(sigs, dl) {
  const out = [];
  for (let i = 0; i < sigs.length; i += 100) {
    const body = await request(`${API_HOST}/v0/transactions?api-key=${encodeURIComponent(key())}`, json({ transactions: sigs.slice(i, i + 100) }), dl, 'parse transactions');
    if (Array.isArray(body)) out.push(...body);
  }
  return out;
}

// Enhanced history for an address, newest first (max 100 per page).
async function addressTransactions(address, { before, limit = 100 } = {}, dl) {
  const qs = new URLSearchParams({ 'api-key': key(), limit: String(limit) });
  if (before) qs.set('before', before);
  const body = await request(`${API_HOST}/v0/addresses/${address}/transactions?${qs}`, { method: 'GET' }, dl, 'address history');
  return Array.isArray(body) ? body : [];
}

module.exports = { rpc, rpcBatch, parseTransactions, addressTransactions, Deadline, HeliusError, sleep };
