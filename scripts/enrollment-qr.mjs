import QRCode from 'qrcode';

export async function terminalEnrollmentQr(uri) {
  const qr = await QRCode.toString(uri, { type: 'utf8', margin: 4 });
  return qr
    .split('\n')
    .map((row) => `\x1b[48;2;255;255;255m\x1b[38;2;0;0;0m${row}\x1b[0m`)
    .join('\n');
}
