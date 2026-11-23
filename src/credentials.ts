import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newEnrollment(username: string, encryptionKey: string) {
  const seed = randomBytes(20);
  const bits = Array.from(seed, (b) => b.toString(2).padStart(8, '0')).join('');
  const secret = bits
    .match(/.{5}/g)!
    .map((s) => alphabet[parseInt(s, 2)])
    .join('');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(encryptionKey), iv);
  cipher.setAAD(Buffer.from(username.toLowerCase()));
  const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
  const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  const uri =
    'otpauth://totp/SuperSync%20Lite:' +
    encodeURIComponent(username) +
    '?' +
    new URLSearchParams({
      secret,
      issuer: 'SuperSync Lite',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
  return { sealed, uri };
}
function key(secret: string) {
  if (!secret || Buffer.byteLength(secret) < 32)
    throw new Error('AUTH_SECRET needs at least 32 bytes');
  return createHash('sha256').update('SuperSync Lite TOTP\0').update(secret).digest();
}
export function verifiedStep(
  sealed: string,
  username: string,
  encryptionKey: string,
  code: string,
  now = Date.now(),
) {
  const raw = Buffer.from(sealed, 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', key(encryptionKey), raw.subarray(0, 12));
  cipher.setAAD(Buffer.from(username.toLowerCase()));
  cipher.setAuthTag(raw.subarray(12, 28));
  const seed = Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]);
  for (const offset of [0, -1, 1]) {
    const step = Math.floor(now / 30000) + offset;
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const digest = createHmac('sha1', seed).update(counter).digest();
    const n = (digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000;
    if (timingSafeEqual(Buffer.from(String(n).padStart(6, '0')), Buffer.from(code))) return step;
  }
  return -1;
}
export const validName = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(value);
