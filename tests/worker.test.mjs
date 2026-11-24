import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import wrangler from 'wrangler';
import { newEnrollment } from '../src/credentials.ts';

import { currentCode } from './totp.mjs';
import { parseCapturePublicKey, sealCapture } from '../src/capture/capture-seal.ts';

import * as contract from '../src/shared/supersync-http-contract.ts';

const { createTestHarness, experimental_readRawConfig, unstable_splitSqlQuery } = wrangler;
const responseContracts = {
  'POST /api/sync/ops': contract.SuperSyncUploadOpsResponseSchema,
  'GET /api/sync/ops': contract.SuperSyncDownloadOpsResponseSchema,
  'POST /api/sync/snapshot': contract.SuperSyncSnapshotUploadResponseSchema,
  'GET /api/sync/status': contract.SuperSyncStatusResponseSchema,
  'GET /api/sync/devices': contract.SuperSyncDevicesResponseSchema,
  'GET /api/sync/restore-points': contract.SuperSyncRestorePointsResponseSchema,
  'DELETE /api/sync/data': contract.SuperSyncDeleteAllDataResponseSchema,
  'POST /api/replace-token': contract.SuperSyncReplaceTokenResponseSchema,
  'POST /api/capture/claim': contract.SuperSyncCaptureClaimResponseSchema,
  'GET /api/capture/grants': contract.SuperSyncCaptureGrantsResponseSchema,
  'POST /api/capture/tokens': contract.SuperSyncCaptureTokenResponseSchema,
  'POST /api/capture/connect-code': contract.SuperSyncCaptureConnectCodeResponseSchema,
};

test('v20.1.0 through the Worker and migrated D1', async (t) => {
  const secret = randomBytes(32).toString('hex'),
    origin = 'http://sync.example';
  const harness = createTestHarness({
    workers: [
      {
        configPath: 'wrangler.jsonc',
        vars: { PUBLIC_URL: origin, CAPTURE_CONNECTOR_ENABLED: 'true' },
        secrets: { AUTH_SECRET: secret },
      },
    ],
  });
  t.after(() => harness.close());
  await harness.listen();
  const worker = harness.getWorker();
  await worker.applyD1Migrations('DB');
  const { DB } = await worker.getEnv();
  async function call(
    path,
    { method = 'GET', body, token, cookie, headers = {}, expected = 200 } = {},
  ) {
    const r = await harness.fetch(origin + path, {
      method,
      headers: {
        origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...headers,
      },
      body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const text = await r.text();
    assert.equal(r.status, expected, path + ' ' + text.slice(0, 500));
    const responseBody =
      text && (r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text);
    if (r.ok) responseContracts[method + ' ' + path.split('?')[0]]?.parse(responseBody);
    return {
      body: responseBody,
      cookie: r.headers.get('set-cookie')?.split(';')[0],
    };
  }
  const login = async (name, admin = 0) => {
    const { sealed, uri } = newEnrollment(name, secret);
    await DB.prepare('INSERT INTO users(username,admin,otp_secret) VALUES(?,?,?)')
      .bind(name, admin, sealed)
      .run();
    const code = currentCode(uri);
    const { cookie } = await call('/web/login', { method: 'POST', body: { username: name, code } });
    await call('/web/login', { method: 'POST', body: { username: name, code }, expected: 401 });
    const {
      body: { token },
    } = await call('/web/token', { method: 'POST', cookie, body: {} });
    return { token, cookie, uri };
  };
  const admin = await login('admin', 1),
    alice = await login('alice'),
    bob = await login('bob');
  const post = (path, token, body, extra = {}) =>
    call(path, { method: 'POST', token, body, ...extra });
  const get = (path, token) => call(path, { token });
  await t.test('OTP account management and one-time browser device claim', async () => {
    assert.deepEqual((await get('/web/login-options')).body, { localAdminLogin: false });
    for (const username of ['admin', 'alice']) {
      await post('/web/login', undefined, { username, code: '' }, { expected: 401 });
    }
    const { body: account } = await call('/web/users', {
      method: 'POST',
      cookie: admin.cookie,
      body: { username: 'charlie' },
      expected: 201,
    });
    assert.ok(account.qr.includes('<svg'));
    await call('/web/users', {
      method: 'POST',
      cookie: alice.cookie,
      body: { username: 'denied' },
      expected: 403,
    });
    const { body: req } = await post('/api/connect/requests', undefined, {
      deviceName: 'Laptop',
      platform: 'windows',
    });
    const path = '/api/connect/requests/' + req.requestId;
    assert.equal((await get(path, alice.token)).body.matchCode, req.matchCode);
    assert.equal(
      (await post(path + '/poll', undefined, { pollSecret: req.pollSecret })).body.status,
      'pending',
    );
    await post(path + '/approve', alice.token);
    const responses = await Promise.all(
      [1, 2].map(() => post(path + '/poll', undefined, { pollSecret: req.pollSecret })),
    );
    assert.deepEqual(responses.map((r) => r.body.status).sort(), ['approved', 'expired']);
    await get('/api/sync/status', responses.find((r) => r.body.token).body.token);
    await call('/api/sync/status', { expected: 401 });

    const cancelled = (
      await post('/api/connect/requests', undefined, {
        deviceName: 'Tablet',
        platform: 'web',
      })
    ).body;
    const page = '/web/connect/' + cancelled.requestId;
    await call(page, { token: alice.token, expected: 401 });
    await post(page + '/cancel', undefined, {}, { cookie: alice.cookie });
    assert.equal(
      (
        await post('/api/connect/requests/' + cancelled.requestId + '/poll', undefined, {
          pollSecret: cancelled.pollSecret,
        })
      ).body.status,
      'denied',
    );
  });
  const payload = randomBytes(140).toString('base64');
  const makeOp = (client, id, clock, entity = 'task') => ({
    id,
    clientId: client,
    actionType: '[Task] Update Task',
    opType: 'UPD',
    entityType: 'TASK',
    entityId: entity,
    payload,
    vectorClock: clock,
    schemaVersion: 1,
    timestamp: Date.now(),
    isPayloadEncrypted: true,
  });
  await t.test(
    'mobile/desktop upload, retry, cursor, conflict, account boundaries and snapshot restore',
    async () => {
      const op = makeOp('A', 'first', { A: 1 });
      const upload = { ops: [op], clientId: 'A', requestId: 'attempt-1', lastKnownServerSeq: 0 };
      const mobile = gzipSync(JSON.stringify(upload)).toString('base64');
      const r = await post('/api/sync/ops', alice.token, mobile, {
        headers: { 'Content-Encoding': 'gzip', 'Content-Transfer-Encoding': 'base64' },
      });
      assert.deepEqual(r.body.results, [{ opId: 'first', accepted: true, serverSeq: 1 }]);
      const repeated = await post('/api/sync/ops', alice.token, upload);
      assert.equal(repeated.body.latestSeq, 1);
      assert.equal(repeated.body.deduplicated, true);
      assert.deepEqual(repeated.body.results, r.body.results);
      assert.equal(
        (await get('/api/sync/ops?sinceSeq=0&excludeClient=B', alice.token)).body.ops[0].op.payload,
        payload,
      );
      assert.equal(
        (await get('/api/sync/ops?sinceSeq=1&excludeClient=B', alice.token)).body.ops.length,
        0,
      );
      assert.equal((await get('/api/sync/ops?sinceSeq=0', bob.token)).body.ops.length, 0);
      const editA = makeOp('A', 'editA', { A: 2 });
      const editB = makeOp('B', 'editB', { A: 1, B: 1 });
      const edits = await Promise.all(
        [editA, editB].map((op) =>
          post(
            '/api/sync/ops',
            alice.token,
            gzipSync(JSON.stringify({ clientId: op.clientId, ops: [op] })),
            { headers: { 'Content-Encoding': 'gzip' } },
          ),
        ),
      );
      assert.deepEqual(edits.map((r) => r.body.results[0].accepted).sort(), [false, true]);
      assert.equal(
        edits.find((r) => !r.body.results[0].accepted).body.results[0].errorCode,
        'CONFLICT_CONCURRENT',
      );
      const duplicate = await post('/api/sync/ops', alice.token, { ops: [op], clientId: 'A' });
      assert.equal(duplicate.body.results[0].errorCode, 'DUPLICATE_OPERATION');
      const snap = {
        opId: crypto.randomUUID(),
        state: randomBytes(1700000).toString('base64'),
        clientId: 'A',
        reason: 'initial',
        vectorClock: { A: 3, B: 2 },
        isPayloadEncrypted: true,
        schemaVersion: 1,
      };
      const snapshot = await post(
        '/api/sync/snapshot',
        alice.token,
        gzipSync(JSON.stringify(snap)),
        { headers: { 'Content-Encoding': 'gzip' } },
      );
      assert.deepEqual(snapshot.body, { accepted: true, serverSeq: 3 });
      assert.deepEqual((await post('/api/sync/snapshot', alice.token, snap)).body, snapshot.body);
      assert.equal(
        (await get('/api/sync/ops?sinceSeq=0&excludeClient=B', alice.token)).body.ops[0].op.payload,
        snap.state,
      );
      assert.equal(
        (await get('/api/sync/restore-points', alice.token)).body.restorePoints[0].serverSeq,
        3,
      );
      assert.equal(
        (await call('/api/sync/restore/3', { token: alice.token, expected: 400 })).body.errorCode,
        'ENCRYPTED_OPS_NOT_SUPPORTED',
      );
      await call('/api/sync/data', { method: 'DELETE', token: alice.token });
      const empty = (await get('/api/sync/ops?sinceSeq=3', alice.token)).body;
      assert.equal(empty.latestSeq, 0);
      assert.equal(empty.gapDetected, true);
      assert.equal(
        (await post('/api/sync/ops', alice.token, { clientId: 'A', ops: [op] })).body.results[0]
          .serverSeq,
        4,
      );
    },
  );
  await t.test('full batches, pagination, stale repair and state replacement fences', async () => {
    const { token } = await login('repair-test');
    const ops = Array.from({ length: 100 }, (_, i) =>
      makeOp('P', 'page-' + i, { P: i + 1 }, 'item-' + i),
    );
    const r = await post('/api/sync/ops', token, { clientId: 'P', ops });
    assert.equal(r.body.results.filter((op) => op.accepted).length, 100);
    assert.equal(r.body.latestSeq, 100);
    const page = (await get('/api/sync/ops?sinceSeq=0&limit=7&excludeClient=Q', token)).body;
    assert.equal(page.ops.length, 7);
    assert.equal(page.hasMore, true);
    assert.equal((await get('/api/sync/ops?sinceSeq=7&limit=7', token)).body.ops[0].serverSeq, 8);
    const snapshot = {
      clientId: 'P',
      state: payload,
      opId: crypto.randomUUID(),
      isPayloadEncrypted: true,
      reason: 'recovery',
      snapshotOpType: 'REPAIR',
      vectorClock: { P: 101 },
      repairBaseServerSeq: 99,
    };
    const stale = await post('/api/sync/snapshot', token, snapshot);
    assert.equal(stale.body.errorCode, 'REPAIR_STALE');
    snapshot.repairBaseServerSeq = 100;
    const repair = await post('/api/sync/snapshot', token, snapshot);
    assert.deepEqual(repair.body, { accepted: true, serverSeq: 101 });
    assert.deepEqual((await post('/api/sync/snapshot', token, snapshot)).body, repair.body);
    const prefix = (await get('/api/sync/ops?sinceSeq=98', token)).body.ops;
    assert.deepEqual(
      prefix.map((o) => o.serverSeq),
      [99, 100, 101],
    );
    const clean = {
      ...snapshot,
      opId: crypto.randomUUID(),
      snapshotOpType: 'BACKUP_IMPORT',
      isCleanSlate: true,
      repairBaseServerSeq: undefined,
      vectorClock: { P: 102 },
    };
    assert.equal((await post('/api/sync/snapshot', token, clean)).body.serverSeq, 102);
    const fenced = (
      await post('/api/sync/ops', token, {
        clientId: 'P',
        ops: [makeOp('P', 'late', { P: 103 })],
        lastKnownServerSeq: 100,
      })
    ).body;
    assert.equal(fenced.results[0].accepted, false);
    assert.equal(fenced.latestSeq, 102);
  });
  await t.test('Capture OAuth PKCE, rotating refresh, MCP task and device lease', async () => {
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .publicKey.export({ type: 'spki', format: 'der' })
      .toString('base64');
    await call('/api/capture/key', { method: 'PUT', token: bob.token, body: { publicKey: key } });
    const {
      body: { code },
    } = await post('/api/capture/connect-code', bob.token, {});
    await post('/web/token/revoke', undefined, {}, { cookie: bob.cookie });
    bob.token = (await post('/web/token', undefined, {}, { cookie: bob.cookie })).body.token;
    const verifier = randomBytes(32).toString('base64url');
    const client_id = 'https://chatgpt.com/oauth/client.json',
      redirect_uri = 'https://chatgpt.com/connector_platform_oauth_redirect',
      resource = origin + '/mcp';
    const query = new URLSearchParams({
      client_id,
      redirect_uri,
      resource,
      response_type: 'code',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      scope: 'tasks:capture offline_access',
      state: 'test',
    });
    assert.equal((await call('/.well-known/oauth-authorization-server')).body.issuer, origin);
    const html = (await call('/oauth/authorize?' + query)).body;
    const authId = html.match(/data-auth-id="([^"]+)"/)[1];
    const {
      body: { redirect },
    } = await post('/oauth/authorize/approve', undefined, { authId, code });
    const oauthCode = new URL(redirect).searchParams.get('code');
    const form = (body) =>
      post('/oauth/token', undefined, new URLSearchParams(body).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    const tokens = (
      await form({
        grant_type: 'authorization_code',
        client_id,
        redirect_uri,
        resource,
        code_verifier: verifier,
        code: oauthCode,
      })
    ).body;
    const refresh = {
      grant_type: 'refresh_token',
      client_id,
      resource,
      refresh_token: tokens.refresh_token,
    };
    const fresh = (await form(refresh)).body;
    await post('/api/capture/connect-code', bob.token, {});
    assert.equal((await form(refresh)).body.refresh_token, fresh.refresh_token);
    const list = await post('/mcp', fresh.access_token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const name = list.body.result.tools[0].name;
    const added = await post('/mcp', fresh.access_token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: { title: 'Capture test' } },
    });
    assert.equal(added.body.result.isError ?? false, false);
    await post('/mcp', fresh.access_token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name, arguments: { title: 'Capture test' } },
    });
    const fingerprint = (await DB.prepare('SELECT fingerprint FROM capture_keys').first())
      .fingerprint;
    const {
      body: { items },
    } = await post('/api/capture/claim', bob.token, { deviceId: 'phone', fingerprint });
    assert.equal(items.length, 1);
    assert.equal(
      (await post('/api/capture/claim', bob.token, { deviceId: 'tablet', fingerprint })).body.items
        .length,
      0,
    );
    assert.equal(
      (
        await post('/api/capture/ack', bob.token, {
          deviceId: 'phone',
          acks: items.map(({ itemId, taskId }) => ({ itemId, taskId })),
        })
      ).body.deleted,
      1,
    );
  });
  await t.test(
    'Capture key, personal token, grant revocation and HTTP route contracts',
    async () => {
      const {
        body: { grant, token },
      } = await post('/api/capture/tokens', bob.token, { clientName: 'Desktop integration' });
      await post('/web/token/revoke', undefined, {}, { cookie: bob.cookie });
      bob.token = (await post('/web/token', undefined, {}, { cookie: bob.cookie })).body.token;
      const grants = (await get('/api/capture/grants', bob.token)).body.grants;
      assert.ok(grants.some((g) => g.id === grant.id));
      const path = '/api/capture/grants/' + grant.id;
      await call(path, { token: alice.token, method: 'DELETE', expected: 404 });
      await post('/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      await call(path, { token: bob.token, method: 'DELETE' });
      await post('/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { expected: 401 });
      const { public_key, fingerprint } = await DB.prepare(
        'SELECT public_key,fingerprint FROM capture_keys',
      ).first();
      const id = crypto.randomUUID();
      const item = {
        id,
        fingerprint,
        ciphertext: sealCapture(parseCapturePublicKey(public_key), id, {
          title: 'Shared from a device',
        }),
      };
      for (let retry = 0; retry < 2; retry++)
        assert.equal((await post('/api/capture/items', bob.token, item)).body.status, 'queued');
      const {
        body: { items },
      } = await post('/api/capture/claim', bob.token, { deviceId: 'phone', fingerprint });
      assert.equal(items.length, 1);
      assert.equal(items[0].ciphertext, item.ciphertext);
      await post('/api/capture/items', bob.token, {}, { expected: 400 });
      await call('/api/capture/key', { token: bob.token, method: 'DELETE' });
      assert.equal((await get('/health')).body.db, 'connected');
      assert.equal((await get('/live')).body.status, 'ok');
      const devices = (await get('/api/sync/devices', alice.token)).body.devices;
      assert.ok(devices.some((d) => d.clientId === 'A' && Number.isInteger(d.lastSeenAt)));
      assert.equal(
        (
          await post(
            '/api/sync/ops',
            alice.token,
            {
              ops: [makeOp('A', 'clear', { A: 1 })].map((op) => ({
                ...op,
                isPayloadEncrypted: false,
              })),
              clientId: 'A',
            },
            { expected: 400 },
          )
        ).body.errorCode,
        'E2EE_REQUIRED',
      );
      await call('/api/register', { method: 'POST', body: {}, expected: 404 });
      await call('/api/sync/restore-points?limit=0', { token: alice.token, expected: 400 });
      const transient = await login('temporary');
      await call('/api/account', { token: transient.token, method: 'DELETE' });
      await call('/api/sync/status', { token: transient.token, expected: 401 });
    },
  );
  await t.test(
    'WebSocket fan-out, encrypted presence, token revocation and isolation',
    async () => {
      const open = async (token, client) => {
        const res = await harness.fetch(
          origin + '/api/sync/ws?' + new URLSearchParams({ token, clientId: client }),
          { headers: { Upgrade: 'websocket' } },
        );
        assert.equal(res.status, 101);
        const ws = res.webSocket,
          frames = [];
        ws.addEventListener('message', (e) => frames.push(JSON.parse(e.data)));
        ws.accept();
        return { ws, frames };
      };
      function closeCode(ws) {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('WebSocket revocation timed out')),
            25000,
          );
          ws.addEventListener(
            'close',
            (event) => {
              clearTimeout(timeout);
              resolve(event.code);
            },
            { once: true },
          );
        });
      }
      async function approvePairing() {
        const { body: request } = await post('/api/connect/requests', undefined, {
          deviceName: 'Device B',
          platform: 'web',
        });
        const page = '/web/connect/' + request.requestId;
        const poll = () =>
          post('/api/connect/requests/' + request.requestId + '/poll', undefined, {
            pollSecret: request.pollSecret,
          });
        assert.equal(
          (await call(page, { cookie: alice.cookie })).body.matchCode,
          request.matchCode,
        );
        assert.deepEqual((await poll()).body, { status: 'pending' });
        await post(page + '/approve', undefined, {}, { cookie: alice.cookie });
        return poll;
      }
      const claim = await approvePairing();
      const paired = (await claim()).body.token;
      const unclaimed = await approvePairing();
      const a = await open(alice.token, 'A'),
        b = await open(paired, 'B'),
        other = await open(bob.token, 'B');
      try {
        a.ws.send(JSON.stringify({ type: 'presence_state', payload: 'opaque-presence' }));
        await post('/api/sync/ops', alice.token, {
          clientId: 'A',
          ops: [makeOp('A', 'ws-write', { A: 10 }, 'new-task')],
        });
        for (let i = 0; i < 50 && !b.frames.some((f) => f.type === 'new_ops'); i++)
          await new Promise((r) => setTimeout(r, 20));
        assert.ok(
          b.frames.some(
            (f) =>
              f.type === 'presence_state' && f.payload === 'opaque-presence' && f.ordinal === 1,
          ),
        );
        assert.ok(b.frames.some((f) => f.type === 'new_ops' && f.latestSeq === 5));
        assert.ok(!a.frames.some((f) => f.type === 'new_ops' && f.latestSeq === 5));
        assert.ok(!other.frames.some((f) => f.type === 'new_ops' || f.type === 'presence_state'));
        await post('/web/token/revoke', alice.token, {}, { expected: 401 });
        await post(
          '/web/token/revoke',
          undefined,
          {},
          {
            cookie: alice.cookie,
            headers: { origin: 'https://other.example' },
            expected: 403,
          },
        );
        const closing = Promise.all([closeCode(a.ws), closeCode(b.ws)]);
        assert.deepEqual(
          (await post('/web/token/revoke', undefined, {}, { cookie: alice.cookie })).body,
          { ok: true },
        );
        assert.deepEqual(await closing, [4003, 4003]);
        await call('/api/sync/status', { token: alice.token, expected: 401 });
        await call('/api/sync/status', { token: paired, expected: 401 });
        assert.deepEqual((await unclaimed()).body, { status: 'expired' });
        assert.equal((await call('/web/me', { cookie: alice.cookie })).body.username, 'alice');
        assert.equal(other.ws.readyState, 1);
        await get('/api/sync/status', bob.token);
        const replacement = (await post('/web/token', undefined, {}, { cookie: alice.cookie })).body
          .token;
        const newClaim = await approvePairing();
        const newPaired = (await newClaim()).body.token;
        for (const fresh of [replacement, newPaired]) {
          const downloaded = await get('/api/sync/ops?sinceSeq=4', fresh);
          assert.equal(downloaded.body.ops[0].op.id, 'ws-write');
        }
        const rotated = await open(replacement, 'C');
        const rotatedClose = closeCode(rotated.ws);
        const { body } = await post('/api/replace-token', replacement, {});
        assert.equal(await rotatedClose, 4003);
        await call('/web/me', { cookie: alice.cookie, expected: 401 });
        await call('/api/sync/status', { token: newPaired, expected: 401 });
        alice.token = body.token;
        await get('/api/sync/status', alice.token);
      } finally {
        for (const c of [a, b, other]) if (c.ws.readyState === 1) c.ws.close(1000);
      }
    },
  );
  await t.test('reset invalidates web and device access without erasing data', async () => {
    const before = await DB.prepare('SELECT COUNT(*) AS n FROM operations').first('n');
    const { cookie } = await post('/web/login', undefined, {
      username: 'alice',
      code: currentCode(alice.uri, 1),
    });
    await call('/web/reset', { method: 'POST', cookie: admin.cookie, body: { username: 'alice' } });
    await call('/web/me', { cookie, expected: 401 });
    await call('/api/sync/status', { token: alice.token, expected: 401 });
    assert.equal(await DB.prepare('SELECT COUNT(*) AS n FROM operations').first('n'), before);
    await get('/api/sync/status', bob.token);
  });
});

test('local admin sign-in on an upgraded database', async (t) => {
  const secret = randomBytes(32).toString('hex');
  const origin = 'http://192.168.1.10:8787';
  const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.jsonc' });
  const harness = createTestHarness({
    workers: [
      {
        config: {
          ...rawConfig,
          define: { 'import.meta.localAdminLogin': 'true' },
        },
        secrets: { AUTH_SECRET: secret },
      },
    ],
  });
  t.after(() => harness.close());
  await harness.listen();
  const { DB } = await harness.getWorker().getEnv();
  async function migrate(name) {
    const sql = await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8');
    await DB.batch(unstable_splitSqlQuery(sql).map((part) => DB.prepare(part)));
  }
  await migrate('0001_initial.sql');
  const admin = newEnrollment('operator', secret);
  const member = newEnrollment('member', secret);
  await DB.prepare(
    'INSERT INTO users(username,admin,otp_secret,token_version) VALUES(?,1,?,7),(?,0,?,2)',
  )
    .bind('operator', admin.sealed, 'member', member.sealed)
    .run();
  const userId = await DB.prepare("SELECT id FROM users WHERE username='operator'").first('id');
  function legacyToken(purpose, tokenVersion) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const iat = Math.floor(Date.now() / 1000);
    const claims = {
      userId,
      email: 'operator',
      tokenVersion,
      purpose,
      iat,
      exp: iat + 3600,
      jti: crypto.randomUUID(),
    };
    const signed = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode(claims);
    return signed + '.' + createHmac('sha256', secret).update(signed).digest('base64url');
  }
  const prior = [6, 7].map((version) => ({
    cookie: 'ss_session=' + legacyToken('web', version),
    authorization: 'Bearer ' + legacyToken('device', version),
    expected: version === 7 ? 200 : 401,
  }));
  await migrate('0002_device_revocation.sql');
  for (const { cookie, authorization, expected } of prior) {
    assert.equal(
      (await harness.fetch(origin + '/web/me', { headers: { cookie } })).status,
      expected,
    );
    assert.equal(
      (await harness.fetch(origin + '/api/sync/status', { headers: { authorization } })).status,
      expected,
    );
  }
  const login = (username, code) =>
    harness.fetch(origin + '/web/login', {
      method: 'POST',
      headers: { origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, code }),
    });
  assert.deepEqual(await (await harness.fetch(origin + '/web/login-options')).json(), {
    localAdminLogin: true,
  });
  const signedIn = await login('operator', '');
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.get('set-cookie').split(';')[0];
  assert.equal((await harness.fetch(origin + '/web/users', { headers: { cookie } })).status, 200);
  assert.equal((await login('operator')).status, 200);
  assert.equal((await login('unknown')).status, 401);
  assert.equal((await login('member', '')).status, 401);
  assert.equal((await login('operator', 'invalid')).status, 401);
  for (const [name, enrollment] of [
    ['operator', admin],
    ['member', member],
  ]) {
    const code = currentCode(enrollment.uri);
    assert.equal((await login(name, code)).status, 200);
    assert.equal((await login(name, code)).status, 401);
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await login('rate-limited', '')).status, 401);
  }
  assert.equal((await login('rate-limited', '')).status, 429);
});

test('default deployment leaves optional Capture routes disabled', async (t) => {
  const harness = createTestHarness({
    workers: [
      { configPath: 'wrangler.jsonc', secrets: { AUTH_SECRET: randomBytes(32).toString('hex') } },
    ],
  });
  t.after(() => harness.close());
  await harness.listen();
  for (const [method, path] of [
    ['GET', '/.well-known/oauth-authorization-server'],
    ['POST', '/mcp'],
    ['GET', '/api/capture/grants'],
  ]) {
    assert.equal((await harness.fetch('http://sync.example' + path, { method })).status, 404, path);
  }
});
