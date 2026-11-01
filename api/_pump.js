// pump.fun on-chain layout: PDAs, BondingCurve decoder, create-instruction parser.
// Layouts follow the IDL shipped in @pump-fun/pump-sdk (pump.json).
const b58 = require('./_b58');
const { findProgramAddress } = require('./_pda');

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM = '11111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const USD1 = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';
const INCINERATOR = '1nc1nerator11111111111111111111111111111111';
const QUOTES = new Set([WSOL, USDC, USDT, USD1]);

const PUMP_SUPPLY_UI = 1e9; // every pump.fun coin mints 1,000,000,000 tokens (6 decimals)
const INITIAL_REAL_TOKEN_RESERVES = 793_100_000e6;

const DISC = {
  bondingCurve: [23, 183, 248, 55, 96, 216, 172, 96],
  create: [24, 30, 200, 40, 5, 28, 7, 119],
  create_v2: [214, 144, 76, 236, 95, 139, 49, 180],
  create_v3: [187, 141, 50, 115, 53, 212, 36, 40],
};
// index of the `user` (signer/payer) account per create flavour
const USER_INDEX = { create: 7, create_v2: 5, create_v3: 5 };

const pdaCache = new Map();
function bondingCurvePda(mint) {
  let v = pdaCache.get(mint);
  if (!v) {
    v = findProgramAddress([Buffer.from('bonding-curve'), b58.decode(mint)], PUMP)[0];
    if (pdaCache.size > 5000) pdaCache.clear();
    pdaCache.set(mint, v);
  }
  return v;
}

const startsWith = (buf, d) => buf.length >= 8 && d.every((x, i) => buf[i] === x);
const u64 = (buf, o) => (o + 8 <= buf.length ? Number(buf.readBigUInt64LE(o)) : 0);
const key = (buf, o) => (o + 32 <= buf.length ? b58.encode(buf.subarray(o, o + 32)) : null);
const ZERO_KEY = SYSTEM;

// BondingCurve: disc(8) vTok(8) vQuote(8) rTok(8) rQuote(8) supply(8) complete(1) creator(32)
// mayhem(1) cashback(1) quote_mint(32) creator_fee_bps(8) can_edit(1). Older curves are shorter;
// the program zero-pads, so do we.
function decodeBondingCurve(data) {
  const raw = Buffer.from(data);
  if (raw.length < 49 || !startsWith(raw, DISC.bondingCurve)) return null;
  const buf = Buffer.alloc(Math.max(124, raw.length));
  raw.copy(buf);
  const creator = raw.length >= 81 ? key(buf, 49) : null;
  let quoteMint = raw.length >= 115 ? key(buf, 83) : null;
  if (!quoteMint || quoteMint === ZERO_KEY) quoteMint = WSOL;
  return {
    virtualTokenReserves: u64(buf, 8),
    virtualQuoteReserves: u64(buf, 16),
    realTokenReserves: u64(buf, 24),
    realQuoteReserves: u64(buf, 32),
    tokenTotalSupply: u64(buf, 40),
    complete: buf[48] === 1,
    creator: creator === ZERO_KEY ? null : creator,
    isMayhemMode: buf[81] === 1,
    quoteMint,
  };
}

const QUOTE_INFO = { [WSOL]: { sym: 'SOL', dec: 9 }, [USDC]: { sym: 'USDC', dec: 6 }, [USDT]: { sym: 'USDT', dec: 6 }, [USD1]: { sym: 'USD1', dec: 6 } };

function curveStats(c) {
  if (!c) return null;
  const q = QUOTE_INFO[c.quoteMint];
  let mcap = null;
  if (q && c.virtualTokenReserves > 0) {
    const price = (c.virtualQuoteReserves / 10 ** q.dec) / (c.virtualTokenReserves / 1e6);
    const supplyUi = (c.tokenTotalSupply || PUMP_SUPPLY_UI * 1e6) / 1e6;
    mcap = price * supplyUi;
  }
  const progress = c.complete ? 100 : Math.max(0, Math.min(100, (1 - c.realTokenReserves / INITIAL_REAL_TOKEN_RESERVES) * 100));
  return { complete: c.complete, creator: c.creator, quote: q ? q.sym : c.quoteMint, mcap, progress };
}

function readString(buf, o) {
  if (o + 4 > buf.length) return [null, o];
  const n = buf.readUInt32LE(o);
  if (n > 400 || o + 4 + n > buf.length) return [null, o];
  return [buf.subarray(o + 4, o + 4 + n).toString('utf8'), o + 4 + n];
}

function parseCreateData(dataB58) {
  let buf;
  try { buf = b58.decode(dataB58 || ''); } catch { return null; }
  let kind = null;
  for (const k of ['create', 'create_v2', 'create_v3']) if (startsWith(buf, DISC[k])) kind = k;
  if (!kind) return null;
  let o = 8, name, symbol, uri;
  [name, o] = readString(buf, o);
  [symbol, o] = readString(buf, o);
  [uri, o] = readString(buf, o);
  const creator = name != null && symbol != null && uri != null && o + 32 <= buf.length ? key(buf, o) : null;
  return { kind, name, symbol, uri, creator };
}

// Every pump.fun create (top-level or CPI) in a Helius enhanced transaction.
function findCreates(tx) {
  const out = [];
  const visit = (ix) => {
    if (!ix || ix.programId !== PUMP) return;
    const p = parseCreateData(ix.data);
    if (!p || !Array.isArray(ix.accounts) || !ix.accounts[0]) return;
    out.push({ kind: p.kind, mint: ix.accounts[0], user: ix.accounts[USER_INDEX[p.kind]] || null, creator: p.creator, name: p.name, symbol: p.symbol });
  };
  for (const ix of tx.instructions || []) {
    visit(ix);
    for (const inner of ix.innerInstructions || []) visit(inner);
  }
  return out;
}

module.exports = {
  PUMP, PUMP_AMM, TOKEN, TOKEN_2022, SYSTEM, WSOL, USDC, USDT, USD1, INCINERATOR, QUOTES,
  PUMP_SUPPLY_UI, DISC, bondingCurvePda, decodeBondingCurve, curveStats, parseCreateData, findCreates,
};
