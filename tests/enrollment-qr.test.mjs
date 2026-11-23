import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalEnrollmentQr } from '../scripts/enrollment-qr.mjs';

test('terminal enrollment QR uses fixed black on white with a four-module quiet zone', async () => {
  const lines = (await terminalEnrollmentQr('disposable enrollment')).split('\n');
  const rows = lines.map((line) => {
    const match = /^\x1b\[48;2;255;255;255m\x1b\[38;2;0;0;0m([ ▀▄█]+)\x1b\[0m$/u.exec(line);
    assert.ok(match, 'each row sets and resets its own true colors');
    return match[1];
  });
  assert.ok([...rows.slice(0, 2), ...rows.slice(-2)].every((row) => !row.trim()));
  assert.ok(rows.every((row) => row.startsWith('    ') && row.endsWith('    ')));
  assert.ok(rows.some((row) => row.trim()));
});
