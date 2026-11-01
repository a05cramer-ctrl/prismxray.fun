// GET /api/bundles?ca=<mint>&slots=4
// Walks the mint's signature history back to the creation slot, parses every
// transaction in the first N slots and returns who bought from the bonding curve.
// Early history never changes, so results are cached for an hour.
const { handler, memo, cacheSet, requireAddress, BadRequest } = require('./_http');
const { rpc, parseTransactions, Deadline } = require('./_helius');
const P = require('./_pump');
const A = require('./_analyze');

const MAX_PAGES = 10;

async function earliestSignatures(mint, dl) {
  let before, pages = 0, tail = [], prevTail = [];
  while (pages < MAX_PAGES) {
    if (!dl.has(3600)) return { reached: false, pages, sigs: tail };
    const page = await rpc('getSignaturesForAddress', [mint, { limit: 1000, before, commitment: 'confirmed' }], dl);
    pages++;
    if (!page.length) break;
    prevTail = tail; tail = page;
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  if (pages >= MAX_PAGES && tail.length === 1000) return { reached: false, pages, sigs: tail };
  // keep the last page plus the one before it, in case the first slots straddle a page boundary
  return { reached: true, pages, sigs: prevTail.concat(tail) };
}

async function bundles(mint, slots, dl) {
  const bc = P.bondingCurvePda(mint);
  const [acc, hist] = await Promise.all([
    rpc('getAccountInfo', [bc, { encoding: 'base64', commitment: 'confirmed' }], dl),
    earliestSignatures(mint, dl),
  ]);
  const v = acc && acc.value;
  const curve = v && v.owner === P.PUMP ? P.decodeBondingCurve(Buffer.from(v.data[0], 'base64')) : null;
  if (!curve) throw new BadRequest('Not a pump.fun coin: this mint has no pump.fun bonding curve', 404);
  if (!hist.reached) {
    return { ok: true, mint, reached: false, notes: [`couldn't read: this coin has more than ${hist.pages * 1000} transactions, too deep to reach its first block in time`] };
  }
  const asc = hist.sigs.slice().reverse();
  if (!asc.length) return { ok: true, mint, reached: true, buyers: [], notes: ["couldn't read: no transactions found for this mint"] };
  const firstSlot = asc[0].slot;
  const window = asc.filter((s) => s.slot <= firstSlot + slots - 1 + 2 && !s.err).slice(0, 100); // +2 slack in case the create isn't first
  const parsed = await parseTransactions(window.map((s) => s.signature), dl);
  const creation = A.findCreation(parsed, mint);
  const notes = [];
  if (!creation) notes.push("couldn't find the create transaction; using the mint's first slot");
  const creationSlot = creation ? creation.slot : firstSlot;
  const creator = curve.creator || (creation && creation.creator) || null;
  const r = A.earlyBuyers(parsed, { mint, bondingCurve: bc, creationSlot, slots, creator });
  if (window.length === 100) notes.push('first slots hold 100+ transactions; read the first 100');
  return {
    ok: true, mint, reached: true, creator, slots, creationSlot,
    createdAt: creation ? creation.at : (asc[0].blockTime ?? null),
    createSignature: creation ? creation.signature : null,
    ...r, wallets: r.buyers.length, notes, at: Math.floor(Date.now() / 1000),
  };
}

module.exports = handler(async (q) => {
  const mint = requireAddress(q.ca);
  const slots = Math.max(1, Math.min(10, parseInt(q.slots, 10) || 4));
  const dl = new Deadline(8800);
  const k = `bundles:${mint}:${slots}`;
  const body = await memo(k, 60 * 60e3, () => bundles(mint, slots, dl));
  if (!body.reached) cacheSet(k, body, 60e3); // incomplete answers expire fast
  return { body, cache: body.reached ? 3600 : 60 };
});
