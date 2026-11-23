import { createHmac } from 'node:crypto';
export function currentCode(uri, offset = 0) {
  const s = new URL(uri).searchParams.get('secret');
  const bits = [...s]
    .map((c) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0'))
    .join('');
  const seed = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const time = Buffer.alloc(8);
  time.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const h = createHmac('sha1', seed).update(time).digest();
  return String((h.readUInt32BE(h[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}
