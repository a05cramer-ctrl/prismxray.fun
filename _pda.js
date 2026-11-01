// Program-derived addresses without @solana/web3.js: sha256 + an ed25519 on-curve test
// that mirrors curve25519-dalek's CompressedEdwardsY::decompress (what Solana uses).
const crypto = require('crypto');
const b58 = require('./_b58');

const P = (1n << 255n) - 19n;
const mod = (a) => { a %= P; return a < 0n ? a + P : a; };
function powm(b, e) {
  let r = 1n; b = mod(b);
  while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; }
  return r;
}
const inv = (a) => powm(a, P - 2n);
const D = mod(-121665n * inv(121666n));

function isOnCurve(bytes) {
  const b = Buffer.from(bytes);
  if (b.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? b[i] & 0x7f : b[i]);
  y = mod(y);
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const x2 = (u * inv(v)) % P;
  if (x2 === 0n) return true;
  return powm(x2, (P - 1n) / 2n) === 1n; // Euler's criterion: x^2 must be a square
}

const toBytes = (k) => (typeof k === 'string' ? b58.decode(k) : Buffer.from(k));

function createProgramAddress(seeds, programId) {
  const h = crypto.createHash('sha256');
  for (const s of seeds) h.update(Buffer.from(s));
  h.update(toBytes(programId));
  h.update(Buffer.from('ProgramDerivedAddress'));
  const out = h.digest();
  if (isOnCurve(out)) return null;
  return out;
}

function findProgramAddress(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    const a = createProgramAddress([...seeds, Buffer.from([bump])], programId);
    if (a) return [b58.encode(a), bump];
  }
  throw new Error('no viable bump');
}

// A wallet (keypair) address is on the curve; a PDA (pool, vault, program-owned) is not.
function isWalletKey(addr) {
  try { return isOnCurve(b58.decode(addr)); } catch { return false; }
}

module.exports = { isOnCurve, findProgramAddress, createProgramAddress, isWalletKey };
