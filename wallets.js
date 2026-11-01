// GET /api/wallets?mint=<mint>&w=<wallet>[:<tokenAccount>],...&creator=<creator>
// For up to 20 wallets: first activity, who funded them (parsed oldest tx), when they
// first held this token (oldest signature on their token account) and whether that
// makes them "fresh" (< 24h between first funding and first hold).
// Used for the fresh-wallet check (top 20 holders) and the bundle funding check.
const { handler, memo, requireAddress, BadRequest } = require('./_http');
const { rpcBatch, parseTransactions, Deadline } = require('./_helius');
const b58 = require('./_b58');
const A = require('./_analyze');

const LIMIT = 300;

function parseList(raw) {
  const items = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
  if (!items.length) throw new BadRequest('"w" must list 1-20 wallets');
  return items.map((it) => {
    const [wallet, ta] = it.split(':');
    if (!b58.isAddress(wallet) || (ta && !b58.isAddress(ta))) throw new BadRequest(`bad wallet entry: ${it.slice(0, 60)}`);
    return { wallet, ta: ta || null };
  });
}

async function lookup(entries, dl) {
  const notes = [];
  const r1 = await rpcBatch(entries.map((e) => ({ method: 'getSignaturesForAddress', params: [e.wallet, { limit: LIMIT }] })), dl);
  const withTa = entries.filter((e) => e.ta);
  const r2 = withTa.length ? await rpcBatch(withTa.map((e) => ({ method: 'getSignaturesForAddress', params: [e.ta, { limit: LIMIT }] })), dl) : [];
  const hold = new Map(withTa.map((e, i) => [e.wallet, r2[i]]));

  const rows = entries.map((e, i) => {
    const res = r1[i];
    if (!res || res.error) return { wallet: e.wallet, error: (res && res.error) || 'no answer' };
    const w = A.oldestOf(res.result, LIMIT);
    const hr = hold.get(e.wallet);
    const h = hr && hr.result ? A.oldestOf(hr.result, LIMIT) : null;
    const f = h ? A.freshVerdict(w, h) : { fresh: null, gapSec: null, why: hr ? 'token history unreadable' : 'not checked' };
    return { wallet: e.wallet, txs: w.count, complete: w.complete, firstAt: w.at, oldestSig: w.sig, holdAt: h ? h.at : null, ...f };
  });

  const toParse = rows.filter((r) => r.complete && r.oldestSig).map((r) => r.oldestSig);
  if (toParse.length && dl.has(1500)) {
    try {
      const parsed = await parseTransactions(toParse, dl);
      const bySig = new Map(parsed.map((t) => [t.signature, t]));
      for (const r of rows) {
        const f = r.oldestSig && A.funderOf(bySig.get(r.oldestSig), r.wallet);
        if (f) { r.funder = f.funder; r.fundedSol = f.sol; r.fundedAt = f.at; }
      }
    } catch (e) { notes.push(`couldn't read funding transactions: ${e.publicMessage || e.message}`); }
  } else if (toParse.length) notes.push("couldn't read funding transactions: out of time");
  for (const r of rows) {
    delete r.oldestSig;
    if (r.complete === false) r.funderNote = `${LIMIT}+ transactions, too old to trace`;
  }
  return { rows, notes };
}

module.exports = handler(async (q) => {
  const mint = requireAddress(q.mint, 'mint');
  const creator = q.creator ? requireAddress(q.creator, 'creator') : null;
  const entries = parseList(q.w);
  const dl = new Deadline(8800);
  const key = 'wallets:' + mint + ':' + entries.map((e) => e.wallet + (e.ta || '')).join(',');
  const { rows, notes } = await memo(key, 5 * 60e3, () => lookup(entries, dl));
  const checked = rows.filter((r) => !r.error && r.fresh !== undefined && r.why !== 'not checked');
  const known = checked.filter((r) => r.fresh !== null);
  const fresh = known.filter((r) => r.fresh);
  return {
    body: {
      ok: true, mint, rows,
      groups: A.fundingGroups(rows, creator),
      fresh: { checked: checked.length, known: known.length, fresh: fresh.length, pct: known.length ? A.round(fresh.length / known.length * 100, 1) : null },
      notes, at: Math.floor(Date.now() / 1000),
    },
    cache: 120,
  };
});
