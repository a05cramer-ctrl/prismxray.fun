// GET /api/dev?ca=<mint>
// Creator from the bonding-curve account, then the creator's enhanced history: every
// pump.fun create it signed, what it bought / sold of each, and how each coin ended.
const { handler, memo, requireAddress, BadRequest } = require('./_http');
const { rpc, rpcBatch, addressTransactions, Deadline } = require('./_helius');
const P = require('./_pump');
const A = require('./_analyze');

const MAX_PAGES = 8;

async function creatorHistory(creator, dl) {
  const txs = [];
  let before, done = false, pages = 0;
  while (pages < MAX_PAGES && dl.has(4200)) {
    const page = await addressTransactions(creator, { before, limit: 100 }, dl);
    pages++;
    txs.push(...page);
    if (page.length < 100) { done = true; break; }
    before = page[page.length - 1].signature;
  }
  const launches = A.devLaunches(creator, txs, P.bondingCurvePda);
  const oldest = txs.length ? txs[txs.length - 1].timestamp : null;
  return { launches: [...launches.values()].map(A.summarizeLaunch), scanned: txs.length, truncated: !done, oldestScannedAt: oldest };
}

async function statuses(mints, dl, notes) {
  const out = new Map();
  const curves = mints.map((m) => P.bondingCurvePda(m));
  for (let i = 0; i < curves.length; i += 100) {
    if (!dl.has(900)) { notes.push("couldn't read every coin's curve: out of time"); break; }
    try {
      const r = await rpc('getMultipleAccounts', [curves.slice(i, i + 100), { encoding: 'base64', commitment: 'confirmed' }], dl);
      (r.value || []).forEach((acc, j) => {
        const m = mints[i + j];
        out.set(m, { curve: acc && acc.owner === P.PUMP ? P.decodeBondingCurve(Buffer.from(acc.data[0], 'base64')) : null });
      });
    } catch (e) { notes.push(`couldn't read curves: ${e.publicMessage || e.message}`); }
  }
  // last trade time for coins still on the curve (newest 20)
  const live = mints.filter((m) => out.get(m) && out.get(m).curve && !out.get(m).curve.complete).slice(0, 20);
  if (live.length && dl.has(1200)) {
    const res = await rpcBatch(live.map((m) => ({ method: 'getSignaturesForAddress', params: [P.bondingCurvePda(m), { limit: 1 }] })), dl);
    res.forEach((r, i) => { if (r.result && r.result[0]) out.get(live[i]).lastActivityAt = r.result[0].blockTime ?? null; });
    if (res.some((r) => r.error)) notes.push("couldn't read last trade for some coins");
  }
  return out;
}

async function dev(mint, dl) {
  const notes = [];
  const bc = P.bondingCurvePda(mint);
  const acc = await rpc('getAccountInfo', [bc, { encoding: 'base64', commitment: 'confirmed' }], dl);
  const v = acc && acc.value;
  const curve = v && v.owner === P.PUMP ? P.decodeBondingCurve(Buffer.from(v.data[0], 'base64')) : null;
  if (!curve) throw new BadRequest('Not a pump.fun coin: this mint has no pump.fun bonding curve', 404);
  if (!curve.creator) {
    return { ok: true, mint, creator: null, verdict: null, launches: [], current: null, notes: ["couldn't read: this bonding curve predates pump.fun's on-chain creator field"] };
  }
  const creator = curve.creator;
  const hist = await memo('creator:' + creator, 5 * 60e3, () => creatorHistory(creator, dl));
  const all = hist.launches.slice().sort((a, b) => b.createdAt - a.createdAt);
  const current = all.find((l) => l.mint === mint) || null;
  const prev = all.filter((l) => l.mint !== mint && (!current || l.createdAt <= current.createdAt));
  const later = all.filter((l) => l.mint !== mint && current && l.createdAt > current.createdAt);
  if (!current) notes.push(hist.truncated ? `this coin's launch is older than the last ${hist.scanned} creator transactions scanned` : "couldn't find this coin's create transaction in the creator's history");

  const st = prev.length + later.length ? await statuses([...prev, ...later].slice(0, 120).map((l) => l.mint), dl, notes) : new Map();
  const now = Math.floor(Date.now() / 1000);
  const decorate = (l) => {
    const s = st.get(l.mint);
    const stats = s && s.curve ? P.curveStats(s.curve) : null;
    return { ...l, status: s ? A.launchStatus({ curve: s.curve, lastActivityAt: s.lastActivityAt ?? null, now }) : 'unknown', mcap: stats && stats.mcap, quote: stats && stats.quote, lastActivityAt: (s && s.lastActivityAt) ?? null };
  };
  const prevOut = prev.map(decorate);
  const counts = {
    launches: prevOut.length,
    dumpedWithinHour: prevOut.filter((l) => l.dumpedWithinHour).length,
    migrated: prevOut.filter((l) => l.status === 'migrated').length,
    trading: prevOut.filter((l) => l.status === 'trading').length,
    dead: prevOut.filter((l) => l.status === 'dead' || l.status === 'closed').length,
  };
  if (hist.truncated) notes.push(`scanned the creator's last ${hist.scanned} transactions; older launches may exist`);
  return {
    ok: true, mint, creator, curve: P.curveStats(curve),
    verdict: A.devVerdict(prevOut, { truncated: hist.truncated }),
    counts, current, launches: prevOut.slice(0, 60), laterLaunches: later.map(decorate).slice(0, 20),
    scanned: hist.scanned, truncated: hist.truncated, notes, at: now,
  };
}

module.exports = handler(async (q) => {
  const mint = requireAddress(q.ca);
  const dl = new Deadline(8800);
  const body = await memo('dev:' + mint, 60e3, () => dev(mint, dl));
  return { body, cache: 60 };
});
