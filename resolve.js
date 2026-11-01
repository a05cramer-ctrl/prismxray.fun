// GET /api/resolve?address=<mint | pair | pool | token account>  ->  { mint, via }
// Lets the extension turn axiom.trade / dexscreener pair URLs into the coin mint.
const { handler, memo, requireAddress, BadRequest } = require('./_http');
const { rpc, addressTransactions, Deadline } = require('./_helius');
const P = require('./_pump');
const b58 = require('./_b58');

const RAY_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAY_CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const RAY_CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

const keyAt = (buf, o) => (buf.length >= o + 32 ? b58.encode(buf.subarray(o, o + 32)) : null);
const pickBase = (a, b) => (a && !P.QUOTES.has(a) ? a : b && !P.QUOTES.has(b) ? b : null);

// Pure: account (owner + raw data) -> mint, or null when the layout is unknown.
function mintFromAccount(address, owner, data) {
  if (owner === P.TOKEN || owner === P.TOKEN_2022) {
    if (data.length === 82) return { mint: address, via: 'mint' };
    if (data.length === 165) return { mint: keyAt(data, 0), via: 'token account' };
    if (owner === P.TOKEN_2022 && data.length > 165) {
      if (data[165] === 1) return { mint: address, via: 'mint' };
      if (data[165] === 2) return { mint: keyAt(data, 0), via: 'token account' };
    }
    return null;
  }
  if (owner === P.PUMP_AMM && data.length >= 75) return { mint: pickBase(keyAt(data, 43), keyAt(data, 75)), via: 'pump amm pool' };
  if (owner === RAY_V4 && data.length >= 464) return { mint: pickBase(keyAt(data, 400), keyAt(data, 432)), via: 'raydium amm' };
  if (owner === RAY_CPMM && data.length >= 232) return { mint: pickBase(keyAt(data, 168), keyAt(data, 200)), via: 'raydium cpmm' };
  if (owner === RAY_CLMM && data.length >= 137) return { mint: pickBase(keyAt(data, 73), keyAt(data, 105)), via: 'raydium clmm' };
  return null;
}

// Pure: most common non-quote mint moved by an address's recent transactions.
function dominantMint(txs) {
  const n = new Map();
  for (const tx of txs) {
    const seen = new Set();
    for (const t of tx.tokenTransfers || []) if (t.mint && !P.QUOTES.has(t.mint)) seen.add(t.mint);
    for (const m of seen) n.set(m, (n.get(m) || 0) + 1);
  }
  let best = null;
  for (const [m, c] of n) if (!best || c > best[1]) best = [m, c];
  return best ? best[0] : null;
}

async function resolve(address, dl) {
  const info = await rpc('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }], dl);
  const v = info && info.value;
  if (!v) throw new BadRequest('That address has no account on Solana mainnet', 404);
  const data = Buffer.from(v.data[0], 'base64');
  const direct = mintFromAccount(address, v.owner, data);
  if (direct && direct.mint) return direct;
  // Bonding curves and unknown pools: read what the address has been trading.
  const txs = await addressTransactions(address, { limit: 25 }, dl);
  const mint = dominantMint(txs);
  if (!mint) throw new BadRequest('Could not find a coin mint behind that address', 404);
  return { mint, via: v.owner === P.PUMP ? 'pump bonding curve' : 'recent trades' };
}

module.exports = handler(async (q) => {
  const address = requireAddress(q.address || q.ca, 'address');
  const dl = new Deadline(8000);
  const r = await memo('resolve:' + address, 10 * 60e3, () => resolve(address, dl));
  return { body: { ok: true, address, ...r }, cache: 600 };
});
module.exports.mintFromAccount = mintFromAccount;
module.exports.dominantMint = dominantMint;
