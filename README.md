# SuperSync Lite

在 Cloudflare Workers 上自托管 SuperSync。每个用户有独立的 D1 同步数据，一个账号可以连接多台运行原版 Super Productivity 的设备。网页管理员负责开户、交付身份验证器二维码和重置登录凭据。同步内容由客户端端到端加密。

兼容基线为 Super Productivity **v20.1.0**，提交 `93d5249d51f4fcfb9ccaab14a89438ae52925a10`。部署到 Cloudflare 后，所有账号都使用用户名和六位 TOTP 登录。设备配对和 Access Token 沿用原版客户端协议。[上游版本](https://github.com/super-productivity/super-productivity/releases/tag/v20.1.0) · [同步协议](https://github.com/super-productivity/super-productivity/blob/93d5249d51f4fcfb9ccaab14a89438ae52925a10/packages/shared-schema/src/supersync-http-contract.ts)

## 本机启动

准备 Node.js 24 和支持 TOTP 的身份验证器。以下命令使用 PowerShell，在仓库根目录运行。

```powershell
npm ci
# 仅在首次创建新的本地环境时生成密钥
if (!(Test-Path .dev.vars)) {
  $key = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
  Set-Content -LiteralPath .dev.vars -Value "AUTH_SECRET=$key" -Encoding ascii
}
npm run migrate:local
node --env-file=.dev.vars scripts/admin.mjs init admin --local
npm run dev
```

打开 `http://localhost:8787`。使用 `npm run dev` 在本机或局域网测试时，已创建的管理员可以只填写用户名，将动态码留空。需要测试管理员 TOTP 时可扫描终端的二维码。普通用户始终需要输入动态码，每个动态码只接受一次。管理员创建用户后，网页显示该用户专属的二维码，请私下交给本人扫描。

在 Windows 局域网中测试时，可用 `npm.cmd run dev -- --ip 192.168.1.10 --var PUBLIC_URL:http://192.168.1.10:8787` 启动，将示例 IP 替换为本机的局域网地址。能访问该地址并知道管理员用户名的设备即可登录本地管理页面。

## 部署到 Cloudflare

1. 在本机执行 `npx wrangler login` 和 `npx wrangler d1 create supersync-lite`。将返回的数据库 ID 写入 [wrangler.jsonc](wrangler.jsonc) 的 `d1_databases[0].database_id`，保留绑定名 `DB`。
2. 将 `vars.PUBLIC_URL` 设置为此 Worker 的公开 HTTPS 源地址，例如 `https://sync.example.com`。默认允许官方网页客户端跨域访问，自托管客户端时将其源地址加入 `CORS_ORIGINS`，多个地址用逗号分隔。需要 Capture、MCP 和 OAuth 时，将 `CAPTURE_CONNECTOR_ENABLED` 设为字符串 `"true"`。Wrangler 会根据配置绑定静态资源和每账号的 Durable Object。
3. 为生产环境单独生成至少 32 字节的随机密钥，在密码管理器中备份，并将同一个值供 Worker 和本地管理员命令使用。此值用于加密 D1 中的 TOTP 种子和签发授权。更换密钥会影响所有现有账号。
4. 在有目标账号权限的 PowerShell 中运行以下命令。将 `AUTH_SECRET` 按原值注入本机环境后执行，二维码只显示在当前终端。首次写入 Worker secret 时，Wrangler 可能提示创建同名 Worker。

```powershell
npx wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc
$env:AUTH_SECRET | npx wrangler secret put AUTH_SECRET --config wrangler.production.jsonc
node scripts/admin.mjs init admin --remote --config wrangler.production.jsonc
npx wrangler deploy --config wrangler.production.jsonc
```

升级已有服务时，先执行上面的远程 D1 迁移命令，再发布 Worker。迁移 `0002_device_revocation.sql` 为已有账号启用独立的设备令牌撤销。部署完成后访问 `/health` 检查 D1 连接，再通过 HTTPS 打开首页登录。请备份 D1 以及对应的生产密钥。同步数据加密密码由用户在客户端设置和保管。

## 接入设备与找回账号

- **浏览器配对**。在原版客户端打开同步设置，选择 SuperSync 和 **Change server**，填写本服务地址，点击 **Sign in with SuperSync**。在弹出的网页输入用户名和 TOTP，核对两个页面上的配对码后批准连接。首次同步设置加密密码，在其他设备输入同一密码即可解密任务。
- **手动填写令牌**。登录服务首页，点击 **生成 Access Token**，将页面上的 **Server URL** 和 **Access Token** 填入客户端的 **Configure Sync**。选择 **SuperSync (Beta)** 后可见令牌字段，服务器地址位于高级设置。
- **撤销并重新授权设备**。在首页点击 **撤销所有设备令牌** 并确认。手动配置和浏览器配对的设备都会断开，已批准但尚未领取的配对也会失效。网页会话、已有同步数据和 Capture 授权会保留。需要恢复同步时，点击 **生成 Access Token** 并在设备上填写新令牌，或在客户端重新发起配对并批准连接。
- **普通用户遗失身份验证器**。管理员登录后台，在该用户旁选择 **重置身份验证器**，交付新二维码。重置保留同步数据，并撤销原动态码、网页会话、设备令牌及 Capture 授权。
- **管理员遗失身份验证器**。部署者在配置好同一 `AUTH_SECRET` 的本机运行 `node scripts/admin.mjs recover admin --remote` 获取新二维码。本地环境使用 `node --env-file=.dev.vars scripts/admin.mjs recover admin --local`。

## 协议与验收

| 范围 | 实现与本地验证 |
| --- | --- |
| 账号和设备 | 管理员开户及重置，TOTP 防重放，网页配对、一次性领取和 Bearer 授权，令牌替换与账号删除 |
| 操作流 | 两个设备的顺序号、游标、重复请求、并发向量时钟冲突、不同账号隔离、gzip 和移动端 base64-gzip |
| 快照与恢复 | 超过 D1 单行限制的加密快照分块、重试、恢复点和清空后序号。上游对加密历史的服务端明文恢复返回 `ENCRYPTED_OPS_NOT_SUPPORTED` |
| 实时通知 | 按账号隔离的 WebSocket，新操作通知、加密跟踪状态、撤销令牌后的关闭通知 |
| Capture（可选） | 密钥、投递、领取与确认、授权管理、OAuth PKCE、刷新令牌轮换、MCP 创建任务 |

```powershell
npm run check
npm test
npx wrangler deploy --dry-run
```

测试在本机 workerd 和临时 D1 上运行。另提供发布版客户端测试，使用两个隔离的 Edge 会话完成配对、解密及双向任务同步，再用第三个会话手动填写 Server URL 和 Access Token，验证能解密同一数据集。先从官方 v20.1.0 发布页获取 `app-play-release.apk` 并核对发布页的摘要，从 APK 解压 `assets/public`，然后执行以下命令。测试仅在回环地址提供这些文件；生产部署只发布本仓库的账号页面。

```powershell
$env:SUPER_SYNC_CLIENT_DIR = 'D:\fixtures\v20.1.0\assets\public'
npm run test:client
```

浏览器默认为本机已安装的 Microsoft Edge，设置 `BROWSER_CHANNEL` 可选择其他已安装的 Playwright Chromium 通道。浏览器验证覆盖官方包内的网页代码；Cloudflare 生产环境和 Android、iOS、桌面原生外壳需要分别验收。

## 跟进上游

[版本检测工作流](.github/workflows/upstream.yml) 在 GitHub 默认分支每周一北京时间 **09:17** 检查最新稳定版，也可通过 **Actions → Check upstream stable release → Run workflow** 手动触发。本机执行 `npm run check:upstream` 可取得同一份报告。报告列出锁定版本、最新版本、提交和差异链接。升级由维护者发起，重新运行兼容验收后再更新 [upstream.json](upstream.json)。

服务移植了上游的同步协议、路由、Capture 及 OAuth 处理逻辑。[上游服务端源码](https://github.com/super-productivity/super-productivity/tree/93d5249d51f4fcfb9ccaab14a89438ae52925a10/packages/super-sync-server/src) · [上游许可证](src/upstream-LICENSE)
