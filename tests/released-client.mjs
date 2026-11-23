import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { createTestHarness } from 'wrangler';
import { newEnrollment } from '../src/credentials.ts';
import { currentCode } from './totp.mjs';
import assert from 'node:assert/strict';
if (!process.env.SUPER_SYNC_CLIENT_DIR)
  throw new Error('Set SUPER_SYNC_CLIENT_DIR to the extracted v20.1.0 assets/public directory');
const root = resolve(process.env.SUPER_SYNC_CLIENT_DIR);
await readFile(resolve(root, 'index.html'));
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
const site = createServer(async (req, res) => {
  try {
    const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname));
    if (file !== root && !file.startsWith(root + sep)) throw Error();
    const f = file === root ? resolve(root, 'index.html') : file;
    res.setHeader('Content-Type', mime[extname(f)] ?? 'application/octet-stream');
    res.end(await readFile(f));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const appUrl = 'http://127.0.0.1:' + site.address().port;
const key = randomBytes(32).toString('hex');
const h = createTestHarness({
  workers: [
    { configPath: 'wrangler.jsonc', vars: { CORS_ORIGINS: appUrl }, secrets: { AUTH_SECRET: key } },
  ],
});
let browser;
try {
  const { url } = await h.listen();
  const addr = url.origin;
  const wh = h.getWorker();
  await wh.applyD1Migrations('DB');
  const { DB } = await wh.getEnv();
  const { sealed, uri } = newEnrollment('demo', key);
  await DB.prepare('INSERT INTO users(username,admin,otp_secret) VALUES(?,?,?)')
    .bind('demo', 1, sealed)
    .run();
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'msedge',
    headless: true,
  });
  const errors = [];
  async function client() {
    const context = await browser.newContext({ locale: 'en-US' });
    context.on('page', (p) => p.on('pageerror', (err) => errors.push(err.message)));
    const page = await context.newPage();
    await page.goto(appUrl);
    await page.getByRole('button', { name: 'Sync!', exact: true }).click();
    await page.getByRole('button', { name: 'Change server', exact: true }).click();
    await page.locator('input[type=url]').fill(addr);
    const popup = context.waitForEvent('page');
    await page.getByRole('button', { name: 'Sign in with SuperSync', exact: true }).click();
    return { page, approval: await popup };
  }
  async function approve({ approval }, offset) {
    await approval.getByLabel('用户名', { exact: true }).fill('demo');
    await approval.getByLabel('身份验证器动态码').fill(currentCode(uri, offset));
    await approval.getByRole('button', { name: '登录', exact: true }).click();
    await approval.getByRole('button', { name: '批准连接', exact: true }).click();
    await approval.getByText('设备已获授权，可以返回 Super Productivity。').waitFor();
  }
  async function addTask(page, title) {
    const input = page.locator('textarea:visible').first();
    await input.fill(title);
    await input.press('Enter');
    await page.keyboard.press('Escape');
    await page.getByText(title, { exact: true }).first().waitFor();
  }
  const [a, b] = await Promise.all([client(), client()]);
  await approve(a, -1);
  await approve(b, 0);
  const pass = randomBytes(16).toString('hex');
  const passwords = a.page.locator('input[type=password]');
  await passwords.nth(0).fill(pass);
  await passwords.nth(1).fill(pass);
  await a.page.getByRole('button', { name: 'Set Password', exact: true }).click();
  await a.page.getByRole('button', { name: 'Back to my tasks' }).click();
  await a.page
    .getByRole('button', { name: /Add more/ })
    .first()
    .click();
  const first = 'From device A ' + crypto.randomUUID(),
    second = 'From device B ' + crypto.randomUUID();
  await addTask(a.page, first);
  const deadline = Date.now() + 60000;
  while (!(await DB.prepare('SELECT 1 AS present FROM operations LIMIT 1').first())) {
    assert.ok(Date.now() < deadline, 'First upload timed out');
    await new Promise((r) => setTimeout(r, 250));
  }
  await b.page.reload();
  await b.page.locator('input[type=password]').first().fill(pass, { timeout: 60000 });
  await b.page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await b.page.getByText(first, { exact: true }).first().waitFor({ timeout: 60000 });
  await b.page.keyboard.press('Shift+A');
  await addTask(b.page, second);
  await a.page.getByText(second, { exact: true }).first().waitFor({ timeout: 90000 });
  const portal = await a.page.context().newPage();
  await portal.goto(addr);
  await portal.getByRole('button', { name: '显示 Access Token' }).click();
  const access = portal.getByLabel('Access Token', { exact: true });
  await access.waitFor({ state: 'visible' });
  const token = await access.inputValue();
  assert.ok(token.length > 0, 'Portal returned an empty token');
  const manual = await browser.newPage({ locale: 'en-US' });
  manual.on('pageerror', (err) => errors.push(err.message));
  await manual.goto(appUrl);
  await manual.getByRole('button', { name: 'Sync!', exact: true }).click();
  await manual.getByRole('button', { name: 'Use WebDAV, Dropbox or a folder' }).click();
  await manual.getByRole('combobox', { name: /Sync provider/i }).click();
  await manual.getByRole('option', { name: /SuperSync/ }).click();
  await manual.locator('.e2e-accessToken input').fill(token);
  await manual
    .getByText(/Advanced (config|settings)/i)
    .first()
    .click();
  await manual.locator('.e2e-baseUrl input:visible').fill(addr);
  await manual.locator('.e2e-baseUrl input:visible').press('Tab');
  const save = manual.getByRole('button', { name: /Save & Enable Sync/ });
  await save.click();
  await manual.locator('input[type=password]').first().fill(pass, { timeout: 60000 });
  await manual.getByRole('button', { name: 'Unlock', exact: true }).click();
  await manual.getByText(second, { exact: true }).first().waitFor({ timeout: 60000 });
  assert.deepEqual(errors, []);
  console.log(
    'Verified the released web client: two TOTP approvals, manual Server URL and Access Token, encryption, and task synchronization in both directions.',
  );
} finally {
  await browser?.close();
  await h.close();
  site.closeAllConnections();
  await new Promise((r) => site.close(r));
}
