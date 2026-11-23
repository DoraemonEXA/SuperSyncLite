import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyError } from 'fastify';
import { Readable } from 'node:stream';
import { STATUS_CODES } from 'node:http';
import { settings } from './context';
import { syncRoutes } from './sync/sync.routes';
import { connectRoutes } from './connect/connect.routes';
import { captureRoutes, captureMcpRoutes } from './capture';
import { captureOAuthRoutes } from './capture/capture-oauth.routes';
import { parseCaptureReviewAccess } from './capture/capture-review';
import {
  CaptureOAuthClientsSchema,
  DEFAULT_CAPTURE_OAUTH_CLIENTS,
} from './capture/capture-oauth-clients';
import { limited } from './web';

type Handler = (req: FastifyRequest, res: FastifyReply) => unknown;
type Done = (error: Error | null, body?: unknown) => void;
type Parser = (req: FastifyRequest, body: Buffer | string, done: Done) => void;
interface Options {
  preHandler?: Handler;
  preParsing?: (req: FastifyRequest, res: FastifyReply, input: Readable, done: Done) => void;
  bodyLimit?: number;
  config?: {
    rateLimit?:
      false | { max: number; timeWindow: string; keyGenerator?: (req: FastifyRequest) => string };
  };
}
class Reply {
  statusCode = 200;
  headers = new Headers({ 'Cache-Control': 'no-store' });
  sent = false;
  payload: unknown;
  code(status: number) {
    this.statusCode = status;
    return this;
  }
  status(status: number) {
    return this.code(status);
  }
  header(k: string, v: string) {
    this.headers.set(k, v);
    return this;
  }
  type(t: string) {
    return this.header('Content-Type', t);
  }
  send(value?: unknown) {
    this.sent = true;
    this.payload = value;
    return this;
  }
  response() {
    if (this.payload === undefined)
      return new Response(null, { status: this.statusCode, headers: this.headers });
    if (typeof this.payload === 'string' && this.headers.get('Content-Type')?.includes('text/'))
      return new Response(this.payload, { status: this.statusCode, headers: this.headers });
    return Response.json(this.payload, { status: this.statusCode, headers: this.headers });
  }
}
interface Route {
  method: string;
  path: string;
  pattern: URLPattern;
  options: Options;
  handler: Handler;
  group: Group;
}
const parseJson: Parser = (_r, body, done) => {
  try {
    done(null, JSON.parse(body.toString()));
  } catch {
    done(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
  }
};
class Group {
  hooks: { onRequest: Handler[]; preHandler: Handler[] } = { onRequest: [], preHandler: [] };
  parsers = new Map<string, { options: { parseAs: string; bodyLimit?: number }; parse: Parser }>();
  errorHandler?: (err: FastifyError, req: FastifyRequest, res: FastifyReply) => unknown;
  constructor(
    private routes: Route[],
    private prefix: string,
  ) {}
  addHook(stage: 'onRequest' | 'preHandler', fn: Handler) {
    this.hooks[stage].push(fn);
  }
  addContentTypeParser(
    type: string,
    options: { parseAs: string; bodyLimit?: number },
    parse: Parser,
  ) {
    this.parsers.set(type, { options, parse });
  }
  getDefaultJsonParser() {
    return parseJson;
  }
  setErrorHandler(fn: Group['errorHandler']) {
    this.errorHandler = fn;
  }
  private route(method: string, path: string, options: Options | Handler, handler?: Handler) {
    const full = this.prefix + path;
    this.routes.push({
      method,
      path: full,
      pattern: new URLPattern({ pathname: full }),
      group: this,
      options: typeof options === 'function' ? {} : options,
      handler: handler ?? (options as Handler),
    });
  }
  get(p: string, o: Options | Handler, h?: Handler) {
    this.route('GET', p, o, h);
  }
  post(p: string, o: Options | Handler, h?: Handler) {
    this.route('POST', p, o, h);
  }
  put(p: string, o: Options | Handler, h?: Handler) {
    this.route('PUT', p, o, h);
  }
  delete(p: string, o: Options | Handler, h?: Handler) {
    this.route('DELETE', p, o, h);
  }
}
async function build(): Promise<Route[]> {
  const env = settings();
  const routes: Route[] = [];
  // Upstream route modules use only this registration, parser, hook and reply surface.
  const group = (prefix = '') => new Group(routes, prefix) as unknown as FastifyInstance;
  await syncRoutes(group('/api/sync'));
  await connectRoutes(group('/api/connect'));
  if (env.CAPTURE_CONNECTOR_ENABLED === 'true') {
    const publicUrl = new URL(env.PUBLIC_URL).origin;
    await captureRoutes(group('/api/capture'));
    await captureMcpRoutes(group(), { publicUrl });
    await captureOAuthRoutes(group(), {
      publicUrl,
      signingKey: env.AUTH_SECRET,
      clients: env.CAPTURE_OAUTH_CLIENTS
        ? CaptureOAuthClientsSchema.parse(JSON.parse(env.CAPTURE_OAUTH_CLIENTS))
        : DEFAULT_CAPTURE_OAUTH_CLIENTS,
      review: parseCaptureReviewAccess(env.CAPTURE_REVIEW_EMAIL, env.CAPTURE_REVIEW_CODE),
    });
  }
  return routes;
}
function callback<T>(invoke: (done: Done) => void): Promise<T> {
  return new Promise((resolve, reject) =>
    invoke((err, v) => (err ? reject(err) : resolve(v as T))),
  );
}
async function parseBody(req: Request, r: FastifyRequest, reply: FastifyReply, route: Route) {
  const type = req.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!type && (!req.body || req.headers.get('content-length') === '0')) return undefined;
  const parser =
    route.group.parsers.get(type ?? '') ??
    (type === 'application/json'
      ? { parse: parseJson, options: { parseAs: 'string', bodyLimit: undefined } }
      : undefined);
  if (!parser) throw Object.assign(new Error('Unsupported Media Type'), { statusCode: 415 });
  const limit = route.options.bodyLimit ?? parser.options.bodyLimit ?? 1048576;
  const source = Readable.from(
    (async function* () {
      if (req.body) for await (const chunk of req.body) yield Buffer.from(chunk);
    })(),
  );
  const stream = route.options.preParsing
    ? await callback<Readable>((done) => route.options.preParsing!(r, reply, source, done))
    : source;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > limit)
      throw Object.assign(new Error('Request body is too large'), {
        statusCode: 413,
        code: 'FST_ERR_CTP_BODY_TOO_LARGE',
      });
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks, bytes);
  if (!buf.length && !req.body && !route.group.parsers.has(type ?? '')) return undefined;
  return callback((done) =>
    parser.parse(r, parser.options.parseAs === 'string' ? buf.toString() : buf, done),
  );
}
let routes: Promise<Route[]> | undefined;
export async function serveApi(req: Request) {
  const url = new URL(req.url),
    reply = new Reply();
  const route = (await (routes ??= build())).find(
    (r) => r.method === req.method && r.pattern.test(url),
  );
  if (!route)
    return reply
      .code(404)
      .send({
        message: 'Route ' + req.method + ':' + url.pathname + ' not found',
        error: 'Not Found',
        statusCode: 404,
      })
      .response();
  const request = {
    headers: Object.fromEntries(req.headers),
    ip: req.headers.get('CF-Connecting-IP') ?? 'local',
    method: req.method,
    routeOptions: { url: route.path },
    params: route.pattern.exec(url)!.pathname.groups,
    query: Object.fromEntries(url.searchParams),
    body: undefined,
  } as unknown as FastifyRequest;
  const res = reply as unknown as FastifyReply;
  try {
    for (const hook of route.group.hooks.onRequest) {
      await hook(request, res);
      if (reply.sent) return reply.response();
    }
    const rule = route.options.config?.rateLimit ?? { max: 500, timeWindow: '15 minutes' };
    if (rule) {
      const [n, unit] = rule.timeWindow.split(' ');
      const duration =
        Number(n) * (unit.startsWith('hour') ? 3600000 : unit.startsWith('minute') ? 60000 : 1000);
      const retry = await limited(
        route.method + route.path + ':' + (rule.keyGenerator?.(request) ?? request.ip),
        rule.max,
        duration,
      );
      if (retry) {
        return reply
          .code(429)
          .header('Retry-After', String(retry))
          .send({ statusCode: 429, error: 'Too Many Requests', message: 'Rate limit exceeded' })
          .response();
      }
    }
    request.body = await parseBody(req, request, res, route);
    for (const hook of [
      ...route.group.hooks.preHandler,
      ...(route.options.preHandler ? [route.options.preHandler] : []),
    ]) {
      await hook(request, res);
      if (reply.sent) return reply.response();
    }
    const value = await route.handler(request, res);
    if (!reply.sent) reply.send(value);
  } catch (e) {
    const err = e as FastifyError;
    try {
      if (route.group.errorHandler) await route.group.errorHandler(err, request, res);
    } catch {
      /* fall through to default response */
    }
    if (!reply.sent) {
      const status = err.statusCode ?? 500;
      if (status >= 500) console.error(route.path, err.message);
      reply
        .code(status >= 500 ? 500 : status)
        .send(
          status >= 500
            ? { statusCode: 500, error: 'Internal Server Error' }
            : {
                statusCode: status,
                code: err.code,
                error: STATUS_CODES[status],
                message: err.message,
              },
        );
    }
  }
  return reply.response();
}
