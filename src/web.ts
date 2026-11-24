import QRCode from 'qrcode';
import { newEnrollment, validName, verifiedStep } from './credentials';
import { settings } from './context';
import { statement } from './db';
import { identify, signAccountToken, revocationWrites, type Identity } from './auth';
import {
  approveConnectRequest,
  cancelConnectRequest,
  CONNECT_REQUEST_ID_PATTERN,
  getPendingConnectRequest,
} from './connect/connect-request.store';

const localAdminLogin = (import.meta as { localAdminLogin?: boolean }).localAdminLogin === true;

export const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
export async function limited(key: string, max: number, window: number) {
  const now = Date.now();
  const row = await statement(
    `INSERT INTO limits(key,attempts,until_ms) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN until_ms<=? THEN 1 ELSE attempts+1 END,until_ms=CASE WHEN until_ms<=? THEN excluded.until_ms ELSE until_ms END RETURNING attempts,until_ms`,
    key,
    now + window,
    now,
    now,
  ).first<{ attempts: number; until_ms: number }>();
  return row && row.attempts > max ? Math.max(1, Math.ceil((row.until_ms - now) / 1000)) : 0;
}

async function webConnect(req: Request, path: string, user: Identity) {
  const match = /^\/web\/connect\/([^/]+)(?:\/(approve|cancel))?$/.exec(path);
  const expired = () => json({ error: '配对请求已过期或已使用，请在客户端重新发起连接。' }, 404);
  if (!match || !CONNECT_REQUEST_ID_PATTERN.test(match[1])) return expired();
  const [, id, action] = match;
  if (req.method !== (action ? 'POST' : 'GET')) return expired();
  // Browser sessions and bearer clients share the upstream per-route pairing quota.
  const route = '/api/connect/requests/:id' + (action ? '/' + action : '');
  const wait = await limited(
    req.method + route + ':' + (req.headers.get('CF-Connecting-IP') ?? 'local'),
    30,
    900000,
  );
  if (wait) return json({ error: 'Too many attempts' }, 429, { 'Retry-After': String(wait) });
  if (!action) {
    const device = await getPendingConnectRequest(id);
    return device ? json(device) : expired();
  }
  const done =
    action === 'approve'
      ? await approveConnectRequest(id, user)
      : await cancelConnectRequest(id, user.userId);
  return done ? json({ ok: true }) : expired();
}

export async function web(req: Request, path: string) {
  const env = settings();
  if (path === '/web/login-options' && req.method === 'GET') return json({ localAdminLogin });
  const cookie = (req.headers.get('Cookie') ?? '').match(
    /(?:^|; *)ss_session=([A-Za-z0-9._-]+)/,
  )?.[1];
  if (
    req.method === 'POST' &&
    (req.headers.get('origin') !== new URL(req.url).origin ||
      !req.headers.get('content-type')?.startsWith('application/json'))
  )
    return json({ error: 'Invalid origin' }, 403);
  let body;
  if (req.method === 'POST') {
    if (Number(req.headers.get('content-length')) > 4096)
      return json({ error: 'Body too large' }, 413);
    try {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (req.body)
        for await (const chunk of req.body) {
          bytes += chunk.byteLength;
          if (bytes > 4096) return json({ error: 'Body too large' }, 413);
          chunks.push(chunk);
        }
      body = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }
  }
  const flags =
    '; HttpOnly; SameSite=Strict; Path=/' +
    (new URL(req.url).protocol === 'https:' ? '; Secure' : '');
  if (path === '/web/login' && req.method === 'POST') {
    const code = body?.code;
    const usernameOnly = localAdminLogin && (code === undefined || code === '');
    if (
      !validName(body?.username) ||
      (!usernameOnly && (typeof code !== 'string' || !/^\d{6}$/.test(code)))
    )
      return json({ error: 'Invalid credentials' }, 401);
    if (
      (await limited('ip:' + (req.headers.get('CF-Connecting-IP') ?? 'local'), 60, 300000)) ||
      (await limited('login:' + body.username.toLowerCase(), 10, 300000))
    )
      return json({ error: 'Too many attempts' }, 429, { 'Retry-After': '300' });
    const row = await statement(
      'SELECT id,username,otp_secret,account_version,admin FROM users WHERE username=?',
      body.username,
    ).first<{
      id: number;
      username: string;
      otp_secret: string;
      account_version: number;
      admin: number;
    }>();
    if (!row || (usernameOnly && !row.admin))
      return json({ error: 'Invalid or already used code' }, 401);
    if (!usernameOnly) {
      const step = verifiedStep(row.otp_secret, row.username, env.AUTH_SECRET, code);
      if (
        step < 0 ||
        !(
          await statement(
            'UPDATE users SET otp_step=? WHERE id=? AND otp_step<? AND account_version=?',
            step,
            row.id,
            step,
            row.account_version,
          ).run()
        ).meta.changes
      )
        return json({ error: 'Invalid or already used code' }, 401);
    }
    return json({ username: row.username, admin: !!row.admin }, 200, {
      'Set-Cookie':
        'ss_session=' +
        signAccountToken(row.id, row.username, row.account_version, 'web') +
        flags +
        '; Max-Age=3600',
    });
  }
  const user = cookie ? await identify(cookie, 'web') : null;
  if (!user) return json({ error: 'Sign in required' }, 401);
  if (path === '/web/me' && req.method === 'GET')
    return json({ username: user.username, admin: !!user.admin });
  if (path === '/web/logout' && req.method === 'POST')
    return json({ ok: true }, 200, { 'Set-Cookie': 'ss_session=' + flags + '; Max-Age=0' });
  if (path === '/web/token' && req.method === 'POST')
    return json({ token: signAccountToken(user.userId, user.username, user.tokenVersion) });
  if (path === '/web/token/revoke' && req.method === 'POST') {
    const hub = env.ACCOUNTS.getByName(String(user.userId));
    const revoked = await hub.revokeDeviceTokens(user.userId, user.accountVersion);
    return revoked ? json({ ok: true }) : json({ error: 'Sign in required' }, 401);
  }
  if (path.startsWith('/web/connect/')) return webConnect(req, path, user);
  if (!user.admin) return json({ error: 'Administrator required' }, 403);
  if (path === '/web/users' && req.method === 'GET')
    return json({
      users: (await statement('SELECT username FROM users WHERE admin=0 ORDER BY username').all())
        .results,
    });
  if (
    (path === '/web/users' || path === '/web/reset') &&
    req.method === 'POST' &&
    validName(body?.username)
  ) {
    const name = body.username;
    const { sealed, uri } = newEnrollment(name, env.AUTH_SECRET);
    const qr = await QRCode.toString(uri, { type: 'svg' });
    if (path === '/web/users') {
      const created = await statement(
        'INSERT INTO users(username,otp_secret) VALUES(?,?) ON CONFLICT(username) DO NOTHING',
        name,
        sealed,
      ).run();
      if (!created.meta.changes) return json({ error: 'Username already exists' }, 409);
    } else {
      const id = await statement(
        'SELECT id FROM users WHERE username=? AND admin=0',
        name,
      ).first<number>('id');
      if (!id) return json({ error: 'Unknown user' }, 404);
      await env.DB.batch([
        statement(
          'UPDATE users SET otp_secret=?,otp_step=-1,token_version=token_version+1 WHERE id=?',
          sealed,
          id,
        ),
        ...revocationWrites(id),
      ]);
      await env.ACCOUNTS.getByName(String(id)).fetch('https://internal/revoke', { method: 'POST' });
    }
    return json({ username: name, qr }, path === '/web/users' ? 201 : 200);
  }
  return json({ error: 'Not found' }, 404);
}
