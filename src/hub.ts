import { DurableObject } from 'cloudflare:workers';
import { authorization, identify, revocationWrites, signAccountToken, type Identity } from './auth';
import { scope, type Settings } from './context';
import { statement } from './db';
import { serveApi } from './http';
import { json, limited } from './web';
import { isValidClientId } from './sync/sync.const';
import { prune } from './sync/sync.service';
import { touchStatement } from './sync/storage';

interface SocketInfo {
  socketId: string;
  cooldown: number;
  user: number;
  client: string;
  version: number;
  connected: number;
  pong: number;
  touched: number;
  window: number;
  count: number;
}
interface Presence {
  client: string;
  payload: string;
  ordinal: number;
  producerConnected: boolean;
  timestamp: number;
}
function send(ws: WebSocket, data: unknown) {
  try {
    ws.send(JSON.stringify(data));
  } catch {
    ws.close(1011, 'Connection lost');
  }
}
export function rejectedSocket(code: number, reason: string) {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(code, reason);
  return new Response(null, { status: 101, webSocket: pair[0] });
}
export class AccountHub extends DurableObject<Settings> {
  private tail: Promise<unknown> = Promise.resolve();
  // Tracking presence is an ephemeral relay. Keep its last frame only while it can be replayed.
  private presence?: Presence;
  private presenceTimer?: ReturnType<typeof setTimeout>;
  private cachePresence(p?: Presence) {
    clearTimeout(this.presenceTimer);
    this.presence = p;
    if (p)
      this.presenceTimer = setTimeout(() => {
        this.presence = undefined;
      }, 1800000);
  }
  private pending?: { exclude: string | undefined; seq: number };
  private notify(client: string, seq: number) {
    if (this.pending) {
      if (this.pending.exclude !== client) this.pending.exclude = undefined;
      this.pending.seq = Math.max(this.pending.seq, seq);
      return;
    }
    this.pending = { exclude: client, seq };
    this.ctx.waitUntil(
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const pending = this.pending!;
        this.pending = undefined;
        await this.broadcast(pending.exclude, {
          type: 'new_ops',
          latestSeq: pending.seq,
          timestamp: Date.now(),
        });
      })(),
    );
  }
  private async serial<T>(task: () => Promise<T>) {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => {});
    return result;
  }
  fetch(req: Request): Promise<Response> {
    return this.serial(() =>
      scope.run({ env: this.env, notify: (client, seq) => this.notify(client, seq) }, async () => {
        const u = new URL(req.url);
        if (u.hostname === 'internal') {
          if (u.pathname === '/revoke') {
            this.closeSockets();
            return json({ ok: true });
          }
          if (u.pathname === '/prune') {
            await prune(Number(u.searchParams.get('id')));
            return json({ ok: true });
          }
          return json({ error: 'Not found' }, 404);
        }
        if (
          this.env.CAPTURE_CONNECTOR_ENABLED === 'true' &&
          (u.pathname === '/mcp' || u.pathname.startsWith('/oauth/'))
        )
          return serveApi(req);
        const ws =
          u.pathname === '/api/sync/ws' &&
          req.headers.get('Upgrade')?.toLowerCase() === 'websocket';
        const user = await identify(ws ? (u.searchParams.get('token') ?? '') : authorization(req));
        if (!user)
          return ws ? rejectedSocket(4003, 'Invalid token') : json({ error: 'Invalid token' }, 401);
        if (ws) return this.acceptClient(user, u.searchParams.get('clientId')!);
        if (req.method === 'POST' && u.pathname === '/api/replace-token') {
          if (
            await limited('replace:' + (req.headers.get('CF-Connecting-IP') ?? 'local'), 5, 900000)
          )
            return json(
              { statusCode: 429, error: 'Too Many Requests', message: 'Rate limit exceeded' },
              429,
              { 'Retry-After': '900' },
            );
          const [r] = await this.env.DB.batch<{ token_version: number }>([
            statement(
              'UPDATE users SET token_version=token_version+1 WHERE id=? AND token_version=? RETURNING token_version',
              user.userId,
              user.tokenVersion,
            ),
            ...revocationWrites(user.userId),
          ]);
          if (!r.results.length) return json({ error: 'Invalid token' }, 401);
          this.closeSockets();
          return json({
            token: signAccountToken(user.userId, user.username, Number(r.results[0].token_version)),
          });
        }
        if (req.method === 'DELETE' && u.pathname === '/api/account') {
          if (
            await limited('delete:' + (req.headers.get('CF-Connecting-IP') ?? 'local'), 3, 900000)
          )
            return json(
              { statusCode: 429, error: 'Too Many Requests', message: 'Rate limit exceeded' },
              429,
              { 'Retry-After': '900' },
            );
          await statement('DELETE FROM users WHERE id=?', user.userId).run();
          this.closeSockets();
          return json({ success: true });
        }
        return serveApi(req);
      }),
    );
  }
  private closeSockets() {
    this.cachePresence();
    for (const socket of this.ctx.getWebSockets()) socket.close(4003, 'Token revoked');
  }
  private async broadcast(exclude: string | undefined, msg: unknown) {
    const sockets = this.ctx.getWebSockets().filter((w) => w.readyState === WebSocket.OPEN);
    if (!sockets.length) return;
    const { user } = sockets[0].deserializeAttachment() as SocketInfo;
    const version = await this.env.DB.prepare('SELECT token_version FROM users WHERE id=?')
      .bind(user)
      .first('token_version');
    for (const socket of sockets) {
      const info = socket.deserializeAttachment() as SocketInfo;
      if (info.version !== version) socket.close(4003, 'Token revoked');
      else if (info.client !== exclude) send(socket, msg);
    }
  }
  private async acceptClient(user: Identity, client: string) {
    if (!isValidClientId(client)) return rejectedSocket(4001, 'Invalid clientId');
    const now = Date.now();
    const peers = this.ctx.getWebSockets(client);
    const existing = peers.find((w) => w.readyState === WebSocket.OPEN);
    if (existing) {
      const incumbent = existing.deserializeAttachment() as SocketInfo;
      if (now < incumbent.cooldown) {
        incumbent.cooldown = now + 5000;
        existing.serializeAttachment(incumbent);
        return rejectedSocket(4008, 'Reconnecting too fast');
      }
      existing.close(4009, 'Replaced by newer connection');
    }
    if (this.ctx.getWebSockets().filter((w) => w.readyState === WebSocket.OPEN).length >= 10)
      return rejectedSocket(4008, 'Too many connections');
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [client]);
    const socketId = crypto.randomUUID();
    await statement('INSERT INTO live_sockets VALUES(?,?,?)', socketId, user.userId, now).run();
    pair[1].serializeAttachment({
      socketId,
      cooldown: now + 5000,
      user: user.userId,
      client,
      version: user.tokenVersion,
      connected: now,
      pong: now,
      touched: now,
      window: now,
      count: 0,
    } satisfies SocketInfo);
    send(pair[1], { type: 'connected', userId: user.userId, timestamp: now });
    const p = this.presence;
    if (p && p.client !== client) send(pair[1], this.frame(p));
    if (p?.client === client && !p.producerConnected) {
      p.producerConnected = true;
      await this.broadcast(client, this.frame(p));
    }
    await touchStatement(user.userId, client).run();
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(now + 30000);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  private frame(p: Presence) {
    const { client, ...rest } = p;
    return { type: 'presence_state', ...rest };
  }
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const info = ws.deserializeAttachment() as SocketInfo;
    const version = await this.env.DB.prepare('SELECT token_version FROM users WHERE id=?')
      .bind(info.user)
      .first('token_version');
    if (version !== info.version) {
      ws.close(4003, 'Token revoked');
      return;
    }
    if (typeof raw !== 'string' || raw.length > 16384) return;
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const now = Date.now();
    if (m?.type === 'pong') {
      info.pong = now;
      ws.serializeAttachment(info);
      return;
    }
    if (
      !['presence_state', 'presence_cmd'].includes(m?.type) ||
      typeof m.payload !== 'string' ||
      !m.payload ||
      Buffer.byteLength(m.payload) > 8192
    )
      return;
    if (now - info.window >= 10000) {
      info.window = now;
      info.count = 0;
    }
    info.count++;
    ws.serializeAttachment(info);
    if (info.count > 15) return;
    if (m.type === 'presence_cmd') {
      await this.broadcast(info.client, { type: m.type, payload: m.payload, timestamp: now });
      return;
    }
    const prev = this.presence;
    const p: Presence = {
      client: info.client,
      payload: m.payload,
      ordinal: (prev?.ordinal ?? 0) + 1,
      producerConnected: true,
      timestamp: now,
    };
    this.cachePresence(p);
    await this.broadcast(info.client, this.frame(p));
  }
  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING)
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    const info = ws.deserializeAttachment() as SocketInfo;
    await this.env.DB.prepare('DELETE FROM live_sockets WHERE socket_id=?')
      .bind(info.socketId)
      .run();
    const p = this.presence;
    if (!this.ctx.getWebSockets().some((w) => w.readyState === WebSocket.OPEN)) {
      this.cachePresence();
      return;
    }
    if (
      p?.client === info.client &&
      !this.ctx.getWebSockets(info.client).some((w) => w.readyState === WebSocket.OPEN)
    ) {
      p.producerConnected = false;
      await this.broadcast(info.client, this.frame(p));
    }
  }
  async alarm() {
    const now = Date.now();
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      const info = ws.deserializeAttachment() as SocketInfo;
      const version = await this.env.DB.prepare('SELECT token_version FROM users WHERE id=?')
        .bind(info.user)
        .first('token_version');
      if (version !== info.version) {
        ws.close(4003, 'Token revoked');
        continue;
      }
      if (now - info.pong > 40000) {
        ws.close(4000, 'Heartbeat timeout');
        continue;
      }
      if (now - info.touched >= 120000) {
        await this.env.DB.prepare('UPDATE devices SET seen=? WHERE user_id=? AND client=?')
          .bind(now, info.user, info.client)
          .run();
        info.touched = now;
        ws.serializeAttachment(info);
      }
      await this.env.DB.prepare('UPDATE live_sockets SET seen=? WHERE socket_id=?')
        .bind(now, info.socketId)
        .run();
      send(ws, { type: 'ping', timestamp: now });
    }
    if (sockets.length) await this.ctx.storage.setAlarm(now + 30000);
  }
}
