import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { settings } from './context';
import { statement } from './db';
export interface Identity {
  userId: number;
  username: string;
  tokenVersion: number;
  accountVersion: number;
  admin: number;
}
const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
export function signAccountToken(
  userId: number,
  email: string,
  tokenVersion: number,
  purpose: 'device' | 'web' = 'device',
) {
  const secret = settings().AUTH_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('Configure AUTH_SECRET');
  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    userId,
    email,
    tokenVersion,
    purpose,
    iat,
    exp: iat + (purpose === 'web' ? 3600 : 365 * 86400),
    jti: randomBytes(12).toString('base64url'),
  };
  const data = header + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url');
  return data + '.' + createHmac('sha256', secret).update(data).digest('base64url');
}
export async function checkToken(
  token: string,
  purpose: 'device' | 'web' = 'device',
): Promise<{ user: Identity; error?: never } | { user: null; error: string }> {
  const invalid = { user: null, error: 'Invalid token' } as const;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== header || !settings().AUTH_SECRET || token.length > 4096)
    return invalid;
  const expected = createHmac('sha256', settings().AUTH_SECRET)
    .update(parts[0] + '.' + parts[1])
    .digest();
  const sig = Buffer.from(parts[2], 'base64url');
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return invalid;
  let c;
  try {
    c = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch {
    return invalid;
  }
  if (c?.purpose !== purpose || !Number.isSafeInteger(c.userId)) return invalid;
  if (!(c.exp > Date.now() / 1000))
    return { user: null, error: 'Token expired. Please log in again to get a new token.' };
  const user = await statement(
    'SELECT id AS userId, username, admin, token_version AS tokenVersion, account_version AS accountVersion FROM users WHERE id=?',
    c.userId,
  ).first<Identity>();
  if (!user) return { user: null, error: 'Account unavailable' };
  const version = purpose === 'web' ? user.accountVersion : user.tokenVersion;
  if (version !== c.tokenVersion)
    return { user: null, error: 'Token was revoked. Please log in again to get a new token.' };
  return { user };
}
export async function identify(token: string, purpose: 'device' | 'web' = 'device') {
  return (await checkToken(token, purpose)).user;
}
export const authorization = (r: Request) =>
  /^Bearer (\S+)$/.exec(r.headers.get('Authorization') ?? '')?.[1] ?? '';
export function revocationWrites(id: number) {
  return [
    statement(
      'UPDATE capture_grants SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL',
      Date.now(),
      id,
    ),
    statement('DELETE FROM capture_connect_codes WHERE user_id=?', id),
    statement('DELETE FROM capture_auth WHERE user_id=?', id),
  ];
}
