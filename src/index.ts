import { scope, type Settings } from './context';
import { authorization, checkToken } from './auth';
import { rejectedSocket } from './hub';
import { isValidClientId } from './sync/sync.const';
import { serveApi } from './http';
import { web, json, limited } from './web';
import { deleteExpiredCaptures } from './capture/capture-queue.store';
import { deleteDeadCaptureGrants } from './capture/capture-grant.store';
import { deleteExpiredConnectRequests } from './connect/connect-request.store';
import { RETENTION_MS } from './sync/sync.types';
export { AccountHub } from './hub';
async function dispatch(req: Request, env: Settings) {
  const u = new URL(req.url),
    path = u.pathname;
  if (path === '/live' && req.method === 'GET') return json({ status: 'ok' });
  if (path === '/health' && req.method === 'GET') {
    try {
      const wsConnections = await env.DB.prepare(
        'SELECT count(*) AS n FROM live_sockets WHERE seen>?',
      )
        .bind(Date.now() - 90000)
        .first('n');
      return json({ status: 'ok', db: 'connected', wsConnections });
    } catch {
      return json({ status: 'error', db: 'disconnected', message: 'Database not responsive' }, 503);
    }
  }
  if (path.startsWith('/web/')) return web(req, path);
  if (path.startsWith('/api/sync/') || path === '/api/replace-token' || path === '/api/account') {
    const ws = path === '/api/sync/ws' && req.headers.get('Upgrade')?.toLowerCase() === 'websocket';
    const token = ws ? u.searchParams.get('token') : authorization(req);
    if (ws) {
      const ip = req.headers.get('CF-Connecting-IP') ?? 'local',
        client = u.searchParams.get('clientId');
      const ipWait = await limited('ws-ip:' + ip, 10000, 900000);
      const wait =
        ipWait ||
        (await limited(
          'ws-client:' + ip + (isValidClientId(client) ? ':' + client : ''),
          120,
          60000,
        ));
      if (wait)
        return json(
          {
            statusCode: 429,
            error: 'Too Many Requests',
            message: 'WebSocket connection rate limit exceeded',
          },
          429,
          { 'Retry-After': String(wait) },
        );
    }
    if (ws && (!token || !isValidClientId(u.searchParams.get('clientId'))))
      return rejectedSocket(4001, !token ? 'Missing token' : 'Invalid clientId');
    const { user, error } = token
      ? await checkToken(token)
      : { user: null, error: 'Missing or invalid Authorization header' };
    if (!user) return ws ? rejectedSocket(4003, 'Invalid token') : json({ error }, 401);
    return env.ACCOUNTS.getByName(String(user.userId)).fetch(req);
  }
  if (env.CAPTURE_CONNECTOR_ENABLED === 'true' && (path === '/mcp' || path.startsWith('/oauth/')))
    return env.ACCOUNTS.getByName('capture').fetch(req);
  if (
    path.startsWith('/api/') ||
    path === '/mcp' ||
    path.startsWith('/oauth/') ||
    path.startsWith('/.well-known/')
  )
    return serveApi(req);
  if (
    req.method === 'GET' &&
    [
      '/',
      '/index.html',
      '/portal.js',
      '/portal.css',
      '/style.css',
      '/capture-oauth.css',
      '/capture-oauth.js',
    ].includes(path)
  ) {
    const asset = await env.ASSETS.fetch(req);
    const out = new Response(asset.body, asset);
    out.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    out.headers.set('Referrer-Policy', 'no-referrer');
    out.headers.set('X-Content-Type-Options', 'nosniff');
    return out;
  }
  return json({ error: 'Not found' }, 404);
}
export default {
  fetch(req: Request, env: Settings) {
    return scope.run({ env }, async () => {
      const origin = req.headers.get('Origin');
      const allowed =
        origin &&
        (origin === new URL(req.url).origin ||
          env.CORS_ORIGINS.split(',')
            .map((x) => x.trim())
            .includes(origin));
      const res =
        req.method === 'OPTIONS' ? new Response(null, { status: 204 }) : await dispatch(req, env);
      if (!allowed || res.status === 101) return res;
      const out = new Response(res.body, res);
      out.headers.set('Access-Control-Allow-Credentials', 'true');
      out.headers.set('Access-Control-Max-Age', '86400');
      out.headers.append('Vary', 'Origin');
      out.headers.set('Access-Control-Allow-Origin', origin);
      out.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
      out.headers.set(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Content-Encoding, Content-Transfer-Encoding, MCP-Protocol-Version, MCP-Method, X-Expected-Rev, X-Force-Overwrite, X-Requested-With',
      );
      out.headers.set(
        'Access-Control-Expose-Headers',
        'Retry-After, WWW-Authenticate, X-Rev, X-Updated-At',
      );
      return out;
    });
  },
  scheduled(_event: ScheduledController, env: Settings, ctx: ExecutionContext) {
    ctx.waitUntil(
      scope.run({ env }, async () => {
        const now = Date.now();
        await deleteExpiredConnectRequests(now);
        await deleteDeadCaptureGrants(now);
        await deleteExpiredCaptures(now - RETENTION_MS);
        await env.DB.prepare('DELETE FROM sync_receipts WHERE expires<=?').bind(now).run();
        await env.DB.prepare('DELETE FROM capture_receipts WHERE expires<=?').bind(now).run();
        await env.DB.prepare('DELETE FROM live_sockets WHERE seen<?')
          .bind(now - 90000)
          .run();
        await env.DB.prepare('DELETE FROM limits WHERE until_ms<=?').bind(now).run();
        await env.DB.prepare('DELETE FROM devices WHERE seen<?')
          .bind(now - 45 * 86400000)
          .run();
        const { results } = await env.DB.prepare('SELECT id FROM users').all<{ id: number }>();
        for (const { id } of results)
          await env.ACCOUNTS.getByName(String(id)).fetch('https://internal/prune?id=' + id);
      }),
    );
  },
};
