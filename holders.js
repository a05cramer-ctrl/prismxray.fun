// GET /api/holders?ca=<mint>
// Token identity (DAS getAsset), bonding-curve state, every holder Helius returns
// (DAS getTokenAccounts, up to 3 pages) merged with getTokenLargestAccounts for an exact top 20.
const { handler, memo, requireAddress } = require('./_http');
const { rpc, Deadline } = require('./_helius');
const P = require('./_pump');
const A = require('./_analyze');

async function holders(mint, dl) {
  const bc = P.bondingCurvePda(mint);
  const notes = [];
  const page = (n) => rpc('getTokenAccounts', { mint, limit: 1000, page: n }, dl);
  const [asset, largest, curveAcc, first] = await Promise.allSettled([
    rpc('getAsset', { id: mint, displayOptions: { showFungible: true } }, dl),
    rpc('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }], dl),
    rpc('getAccountInfo', [bc, { encoding: 'base64', commitment: 'confirmed' }], dl),
    page(1),
  ]);

  // token identity
  const a = asset.status === 'fulfilled' ? asset.value : null;
  if (!a) notes.push(`couldn't read token metadata: ${reason(asset)}`);
  const ti = (a && a.token_info) || {};
  let decimals = ti.decimals;
  let supplyRaw = Number(ti.supply) || 0;
  if (!supplyRaw && dl.has(1500)) {
    try { const s = await rpc('getTokenSupply', [mint], dl); supplyRaw = Number(s.value.amount); decimals = s.value.decimals; }
    catch (e) { notes.push(`couldn't read supply: ${e.publicMessage || e.message}`); }
  }
  const content = (a && a.content) || {};
  const token = {
    name: (content.metadata && content.metadata.name) || null,
    symbol: (content.metadata && content.metadata.symbol) || ti.symbol || null,
    image: (content.links && content.links.image) || (content.files && content.files[0] && (content.files[0].cdn_uri || content.files[0].uri)) || null,
    decimals: decimals ?? null,
    supply: supplyRaw && decimals != null ? supplyRaw / 10 ** decimals : null,
    program: ti.token_program || null,
  };

  // bonding curve
  let curve = { address: bc, exists: false };
  if (curveAcc.status === 'fulfilled') {
    const v = curveAcc.value && curveAcc.value.value;
    const dec = v ? P.decodeBondingCurve(Buffer.from(v.data[0], 'base64')) : null;
    if (v && v.owner === P.PUMP && dec) curve = { address: bc, exists: true, ...P.curveStats(dec) };
  } else notes.push(`couldn't read bonding curve: ${reason(curveAcc)}`);

  // holders
  let accounts = [];
  let capped = false;
  if (first.status === 'fulfilled') {
    const r = first.value || {};
    accounts = (r.token_accounts || []).slice();
    let n = 1;
    while ((r.token_accounts || []).length === 1000 && accounts.length === n * 1000 && n < 3 && dl.has(2500)) {
      n++;
      try { const more = await page(n); accounts.push(...(more.token_accounts || [])); if ((more.token_accounts || []).length < 1000) break; }
      catch (e) { notes.push(`stopped reading holders at page ${n}: ${e.publicMessage || e.message}`); break; }
    }
    if (accounts.length >= n * 1000) capped = true;
  } else notes.push(`couldn't list holders: ${reason(first)}`);

  // Exact top 20 by balance, owners filled from the account list or a parsed lookup.
  if (largest.status === 'fulfilled') {
    const top = (largest.value && largest.value.value) || [];
    const known = new Map(accounts.map((x) => [x.address, x]));
    const missing = top.filter((t) => !known.has(t.address)).map((t) => t.address);
    if (missing.length && dl.has(1200)) {
      try {
        const m = await rpc('getMultipleAccounts', [missing, { encoding: 'jsonParsed' }], dl);
        (m.value || []).forEach((acc, i) => {
          const owner = acc && acc.data && acc.data.parsed && acc.data.parsed.info && acc.data.parsed.info.owner;
          if (owner) known.set(missing[i], { address: missing[i], owner, amount: 0 });
        });
      } catch (e) { notes.push(`couldn't read some top-holder owners: ${e.publicMessage || e.message}`); }
    }
    for (const t of top) {
      const k = known.get(t.address);
      if (!k) continue;
      k.amount = Number(t.amount);
      if (!accounts.includes(k)) accounts.push(k);
    }
  } else notes.push(`couldn't read largest accounts: ${reason(largest)}`);

  const summary = accounts.length ? A.summarizeHolders(accounts, { supplyRaw, bondingCurve: bc }) : null;
  if (!supplyRaw) notes.push("couldn't compute %: total supply unknown");
  return {
    ok: true, mint, token, curve,
    holders: summary ? { ...summary, capped } : null,
    notes, at: Math.floor(Date.now() / 1000),
  };
}

function reason(r) { return (r.reason && (r.reason.publicMessage || r.reason.message)) || 'unknown error'; }

module.exports = handler(async (q) => {
  const mint = requireAddress(q.ca);
  const dl = new Deadline(8500);
  const body = await memo('holders:' + mint, 60e3, () => holders(mint, dl));
  return { body, cache: 30 };
});
