// Minimal base58 (Bitcoin alphabet) used by Solana addresses and Helius instruction data.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = {};
for (let i = 0; i < ALPHABET.length; i++) MAP[ALPHABET[i]] = i;

function decode(str) {
  if (typeof str !== 'string') throw new Error('base58: expected string');
  const bytes = [];
  for (const ch of str) {
    let carry = MAP[ch];
    if (carry === undefined) throw new Error('base58: bad character');
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of str) { if (ch === '1') bytes.push(0); else break; }
  return Buffer.from(bytes.reverse());
}

function encode(buf) {
  const src = Buffer.from(buf);
  const digits = [];
  for (const byte of src) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const byte of src) { if (byte === 0) out += '1'; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function isAddress(s) {
  if (typeof s !== 'string' || !ADDR_RE.test(s)) return false;
  try { return decode(s).length === 32; } catch { return false; }
}

module.exports = { decode, encode, isAddress };
