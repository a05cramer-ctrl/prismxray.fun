// Pure analysis over Helius-shaped data. No I/O here, so every rule is unit-tested.
const { findCreates, PUMP_SUPPLY_UI, PUMP, PUMP_AMM, INCINERATOR } = require('./_pump');
const { isWalletKey } = require('./_pda');

const HOUR = 3600, DAY = 86400;
const ok = (tx) => tx && !tx.transactionError;

// ---------- dev history ----------
// txs: the creator's enhanced history (newest first). Returns launches keyed by mint.
function devLaunches(creator, txs, bcOf) {
  const launches = new Map();
  for (const tx of txs) {
    if (!ok(tx)) continue;
    for (const c of findCreates(tx)) {
      const by = c.creator || c.user;
      if (by !== creator) continue;
      const prev = launches.get(c.mint);
      if (prev && prev.createdAt <= tx.timestamp) continue;
      launches.set(c.mint, {
        mint: c.mint, name: c.name || null, symbol: c.symbol || null,
        createdAt: tx.timestamp, slot: tx.slot, signature: tx.signature,
        devIn: 0, devOut: 0, devSold: 0, outs: [],
      });
    }
  }
  for (const tx of txs) {
    if (!ok(tx)) continue;
    for (const t of tx.tokenTransfers || []) {
      const L = launches.get(t.mint);
      if (!L) continue;
      const amt = Number(t.tokenAmount) || 0;
      if (amt <= 0) continue;
      if (t.toUserAccount === creator && t.fromUserAccount !== creator) L.devIn += amt;
      if (t.fromUserAccount === creator && t.toUserAccount !== creator) {
        const sold = t.toUserAccount === bcOf(t.mint) || isSaleTx(tx);
        L.devOut += amt;
        if (sold) L.devSold += amt;
        L.outs.push({ at: tx.timestamp, amt, sold });
      }
    }
  }
  return launches;
}

function isSaleTx(tx) {
  if (/SELL|SWAP/.test(tx.type || '')) return true;
  return (tx.instructions || []).some((ix) => ix.programId === PUMP || ix.programId === PUMP_AMM);
}

function summarizeLaunch(L) {
  const outs = L.outs.slice().sort((a, b) => a.at - b.at);
  const firstOut = outs.length ? outs[0].at : null;
  const outWithinHour = outs.filter((o) => o.at - L.createdAt <= HOUR).reduce((s, o) => s + o.amt, 0);
  return {
    mint: L.mint, name: L.name, symbol: L.symbol, createdAt: L.createdAt, signature: L.signature,
    devBoughtPct: round(L.devIn / PUMP_SUPPLY_UI * 100, 3),
    devSoldPct: round(L.devSold / PUMP_SUPPLY_UI * 100, 3),
    devOutPct: round(L.devOut / PUMP_SUPPLY_UI * 100, 3),
    firstSellAfterSec: firstOut == null ? null : Math.max(0, firstOut - L.createdAt),
    // "dumped within 1h": the dev sent out at least half of what it got, inside the first hour.
    dumpedWithinHour: L.devIn > 0 && outWithinHour >= 0.5 * L.devIn,
  };
}

function launchStatus({ curve, lastActivityAt, now }) {
  if (curve === null) return 'closed';
  if (curve && curve.complete) return 'migrated';
  if (lastActivityAt == null) return 'unknown';
  return now - lastActivityAt < DAY ? 'trading' : 'dead';
}

function devVerdict(prev, { truncated } = {}) {
  const n = prev.length;
  if (!n) return truncated ? 'No earlier launches in the scanned history' : 'First launch from this wallet';
  const dumped = prev.filter((l) => l.dumpedWithinHour).length;
  const migrated = prev.filter((l) => l.status === 'migrated').length;
  return `${n} launch${n === 1 ? '' : 'es'} · ${dumped} dumped within 1h · ${migrated} migrated`;
}

// ---------- bundles ----------
function earlyBuyers(txs, { mint, bondingCurve, creationSlot, slots, creator }) {
  const lastSlot = creationSlot + slots - 1;
  const buyers = new Map();
  let txCount = 0;
  for (const tx of txs) {
    if (!ok(tx) || tx.slot < creationSlot || tx.slot > lastSlot) continue;
    let counted = false;
    for (const t of tx.tokenTransfers || []) {
      if (t.mint !== mint || t.fromUserAccount !== bondingCurve) continue;
      const to = t.toUserAccount;
      const amt = Number(t.tokenAmount) || 0;
      if (!to || to === bondingCurve || amt <= 0) continue;
      if (!counted) { txCount++; counted = true; }
      const b = buyers.get(to) || { wallet: to, tokens: 0, slot: tx.slot, isDev: to === creator };
      b.tokens += amt;
      b.slot = Math.min(b.slot, tx.slot);
      buyers.set(to, b);
    }
  }
  const list = [...buyers.values()].map((b) => ({ wallet: b.wallet, pct: round(b.tokens / PUMP_SUPPLY_UI * 100, 3), slotOffset: b.slot - creationSlot, isDev: b.isDev }))
    .sort((a, b) => b.pct - a.pct);
  const combinedPct = round(list.reduce((s, b) => s + b.pct, 0), 3);
  const exDevPct = round(list.filter((b) => !b.isDev).reduce((s, b) => s + b.pct, 0), 3);
  return { buyers: list, combinedPct, exDevPct, buyTxs: txCount };
}

// Find the creation tx among the earliest parsed transactions.
function findCreation(txs, mint) {
  const sorted = txs.filter(ok).sort((a, b) => a.slot - b.slot);
  for (const tx of sorted) {
    const c = findCreates(tx).find((x) => x.mint === mint);
    if (c) return { slot: tx.slot, at: tx.timestamp, signature: tx.signature, creator: c.creator || c.user };
  }
  return null;
}

// ---------- wallets: funding + freshness ----------
// Who funded a wallet, judged from its oldest transaction.
function funderOf(tx, wallet) {
  if (!tx) return null;
  const sol = (tx.nativeTransfers || []).filter((n) => n.toUserAccount === wallet && n.fromUserAccount && n.fromUserAccount !== wallet)
    .sort((a, b) => b.amount - a.amount)[0];
  if (sol) return { funder: sol.fromUserAccount, sol: round(sol.amount / 1e9, 4), at: tx.timestamp };
  const tok = (tx.tokenTransfers || []).find((t) => t.toUserAccount === wallet && t.fromUserAccount && t.fromUserAccount !== wallet);
  if (tok) return { funder: tok.fromUserAccount, sol: null, at: tx.timestamp };
  return null;
}

// sigs lists come newest first; `complete` means we saw the whole history.
function oldestOf(sigs, limit) {
  if (!Array.isArray(sigs) || !sigs.length) return { complete: true, at: null, sig: null, count: 0 };
  const last = sigs[sigs.length - 1];
  return { complete: sigs.length < limit, at: last.blockTime ?? null, sig: last.signature, count: sigs.length };
}

// Fresh = the wallet's first-ever activity was < 24h before it first held this token.
// Works with partial histories: proves fresh / not fresh when bounds allow, else null.
function freshVerdict(wallet, hold) {
  if (!hold || hold.at == null || wallet.at == null) return { fresh: null, gapSec: null, why: 'no timestamps' };
  if (wallet.complete && hold.complete) { const gap = hold.at - wallet.at; return { fresh: gap < DAY, gapSec: Math.max(0, gap), why: 'exact' }; }
  if (!wallet.complete && hold.complete) {
    const lower = hold.at - wallet.at; // wallet existed at least this long before buying
    return lower >= DAY ? { fresh: false, gapSec: null, why: 'wallet older than its visible history' } : { fresh: null, gapSec: null, why: 'wallet history too long to date' };
  }
  if (wallet.complete && !hold.complete) {
    const upper = hold.at - wallet.at; // first hold happened no later than hold.at
    return upper < DAY ? { fresh: true, gapSec: null, why: 'held within 24h of first activity' } : { fresh: null, gapSec: null, why: 'token history too long to date' };
  }
  return { fresh: null, gapSec: null, why: 'histories too long to date' };
}

const EXCHANGES = new Set([
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', // Binance
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm', // Coinbase
  'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2', // Bybit
  'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5', // Kraken
  '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD', // OKX
]);

// Group wallets by funder. Exchange hot wallets fund everyone, so they never count as a link.
function fundingGroups(rows, creator) {
  const by = new Map();
  for (const r of rows) {
    if (!r.funder) continue;
    if (!by.has(r.funder)) by.set(r.funder, []);
    by.get(r.funder).push(r.wallet);
  }
  const groups = [...by.entries()]
    .map(([funder, wallets]) => ({ funder, wallets, exchange: EXCHANGES.has(funder), isDev: funder === creator }))
    .filter((g) => !g.exchange && (g.wallets.length >= 2 || g.isDev))
    .sort((a, b) => b.wallets.length - a.wallets.length);
  return groups;
}

// ---------- holders ----------
function classifyOwner(owner, bondingCurve) {
  if (owner === bondingCurve) return 'curve';
  if (owner === INCINERATOR) return 'burn';
  return isWalletKey(owner) ? 'wallet' : 'pool';
}

// accounts: [{address, owner, amount(raw number)}]; supplyRaw: raw total supply.
function summarizeHolders(accounts, { supplyRaw, bondingCurve, maxDots = 300 }) {
  const byOwner = new Map();
  for (const a of accounts) {
    const amt = Number(a.amount) || 0;
    if (amt <= 0 || !a.owner) continue;
    const e = byOwner.get(a.owner) || { wallet: a.owner, raw: 0, ta: a.address, taRaw: 0 };
    e.raw += amt;
    if (amt > e.taRaw) { e.ta = a.address; e.taRaw = amt; }
    byOwner.set(a.owner, e);
  }
  const rows = [...byOwner.values()].map((e) => ({
    wallet: e.wallet, ta: e.ta, pct: supplyRaw > 0 ? e.raw / supplyRaw * 100 : 0, tag: classifyOwner(e.wallet, bondingCurve),
  })).sort((a, b) => b.pct - a.pct);
  const wallets = rows.filter((r) => r.tag === 'wallet');
  const excluded = rows.filter((r) => r.tag !== 'wallet').slice(0, 6).map((r) => ({ ...r, pct: round(r.pct, 3) }));
  const top10 = wallets.slice(0, 10);
  return {
    holderCount: wallets.length,
    top10Pct: round(top10.reduce((s, r) => s + r.pct, 0), 3),
    top20: wallets.slice(0, 20).map((r) => ({ wallet: r.wallet, ta: r.ta, pct: round(r.pct, 4) })),
    excluded,
    dots: wallets.slice(0, maxDots).map((r) => ({ w: r.wallet, p: round(r.pct, 4) })),
  };
}

function round(x, d) { const m = 10 ** d; return Math.round(x * m) / m; }

module.exports = {
  devLaunches, summarizeLaunch, launchStatus, devVerdict, earlyBuyers, findCreation,
  funderOf, oldestOf, freshVerdict, fundingGroups, classifyOwner, summarizeHolders, EXCHANGES, round, DAY, HOUR,
};
