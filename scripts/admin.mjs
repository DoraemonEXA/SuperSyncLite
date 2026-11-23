import { newEnrollment, validName } from '../src/credentials.ts';
import { terminalEnrollmentQr } from './enrollment-qr.mjs';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const [mode, username, target, ...extra] = process.argv.slice(2);
if (
  extra.length &&
  !(target === '--local' && extra.length === 2 && extra[0] === '--persist-to' && extra[1])
)
  throw new Error('Only --local accepts --persist-to DIRECTORY');
if (
  !['init', 'recover'].includes(mode) ||
  !validName(username) ||
  !['--local', '--remote'].includes(target)
) {
  throw new Error('Usage: npm run admin -- init|recover USERNAME --local|--remote');
}
const { sealed, uri } = newEnrollment(username, process.env.AUTH_SECRET);
const directory = mkdtempSync(join(tmpdir(), 'supersync-admin-'));
const file = join(directory, 'provision.sql');
// Both interpolated fields are restricted to alphanumerics and URL-safe punctuation.
const id = "(SELECT id FROM users WHERE username='" + username + "' AND admin=1)";
const query =
  mode === 'init'
    ? "INSERT INTO write_guard SELECT NOT EXISTS(SELECT 1 FROM users WHERE admin=1); INSERT INTO users(username,otp_secret,admin) VALUES('" +
      username +
      "','" +
      sealed +
      "',1); DELETE FROM write_guard;"
    : 'INSERT INTO write_guard SELECT EXISTS(SELECT 1 FROM users WHERE id=' +
      id +
      "); UPDATE users SET otp_step=-1,token_version=token_version+1,otp_secret='" +
      sealed +
      "' WHERE id=" +
      id +
      '; UPDATE capture_grants SET revoked_at=unixepoch()*1000 WHERE user_id=' +
      id +
      '; DELETE FROM capture_connect_codes WHERE user_id=' +
      id +
      '; DELETE FROM capture_auth WHERE user_id=' +
      id +
      '; DELETE FROM write_guard;';
try {
  writeFileSync(file, query, { mode: 0o600 });
  const r = spawnSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'd1',
      'execute',
      'DB',
      target,
      '--file',
      file,
      ...extra,
    ],
    { stdio: ['inherit', 'pipe', 'pipe'] },
  );
  if (r.status !== 0)
    throw new Error(
      'D1 provisioning failed. Check the migration, admin name, target database and Wrangler credentials.',
    );
  console.log(await terminalEnrollmentQr(uri));
} finally {
  unlinkSync(file);
  rmdirSync(directory);
}
