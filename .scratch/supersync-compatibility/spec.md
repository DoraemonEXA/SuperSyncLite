# SuperSync Lite compatibility

Run a multi-user SuperSync service on Cloudflare Workers with Cloudflare D1, usable from an unmodified Super Productivity client. The initial reference is Super Productivity v20.1.0, commit `93d5249d51f4fcfb9ccaab14a89438ae52925a10`.

## Accounts and device setup

- The deployment operator uses a local command to provision or recover the administrator. Administrators use a web interface to create users and hand each user their authenticator enrollment QR code.
- Both roles sign in with a username and a six-digit TOTP on hosted Workers. The local Wrangler launcher permits username-only sign-in for a provisioned administrator. Public registration and email delivery are outside the service. The admin interface is limited to account management. Each user's devices share only that user's dataset.
- Standard device setup starts in the client. The app opens `/?r=<requestId>` on the server. The user signs in, checks the match code and approves the device. The app receives its access token on its next successful poll. Also support entering the Server URL and Access Token in client settings. The enrollment QR code is for the user's authenticator.
- Replacing a lost authenticator keeps that user's data and invalidates the old authenticator, web sessions and device authorizations. The user's other devices must reconnect. Other users continue syncing.
- Users can revoke all their sync devices, including approved pairings awaiting collection. Their portal sessions and Capture authorizations continue working. They can manually generate a new token or approve a fresh pairing to reconnect to their dataset.

The optional upstream Capture, MCP and OAuth routes are part of the implementation and follow the upstream feature switch.

## Compatibility evidence

- Compare each implemented endpoint with the route handler and schema from the pinned commit. Record authentication, request and response encoding, optional fields, errors and status codes. Include HTTP and WebSocket behavior.
- Exercise the Worker with locally migrated D1. Upload from device A, download on B, repeat A's upload and resume from B's cursor. Exercise concurrent edits, duplicate operation IDs, snapshot upload and restore, dataset deletion, and notifications. Use a second account to verify isolation for reads, writes and notifications.
- Run device setup, manual token entry and a two-device sync with the released client. Report exactly which clients and environments were exercised alongside the upstream commit.
- Test binary gzip and base64-wrapped gzip uploads from the released client transports. Compare encrypted restore behavior with the upstream response. Keep sequence allocation monotonic across a dataset reset and test a reconnecting device with an old cursor.

## Local acceptance for v20.1.0

The official release asset `app-play-release.apk`, SHA-256 `cc509b8d8db6587aa4f90bf9f293bdb7b9afeb4456a7865e4dff887ba5f496a3`, supplied the unmodified browser code. Two isolated Microsoft Edge sessions approved the browser pairing and exchanged encrypted tasks in both directions. After portal revocation, a third session entered the URL and a newly generated token through Configure Sync and decrypted the same tasks. Run `npm run test:client` to repeat this against a local Worker and D1.

The local Worker tests cover full-size operation batches, cursors and request receipts, concurrent edits, account boundaries, snapshot chunking, repair and replacement fences, WebSocket fan-out and revocation, OAuth refresh and Capture delivery. Both the enabled and default-disabled Capture configurations were exercised. Separate CLI checks initialized one administrator, rejected a second initialization, and generated a fresh recovery QR. Remote Cloudflare infrastructure, native device runtimes and a scheduled run on GitHub are outside this local acceptance.

## Following new releases

GitHub Actions checks the upstream stable release every Monday at 01:17 UTC and on manual dispatch. It reports changes relative to the verified baseline. A maintainer initiates each upgrade.

## References

- [Upstream server](https://github.com/super-productivity/super-productivity/tree/93d5249d51f4fcfb9ccaab14a89438ae52925a10/packages/super-sync-server/src)
- [Shared HTTP contract](https://github.com/super-productivity/super-productivity/blob/93d5249d51f4fcfb9ccaab14a89438ae52925a10/packages/shared-schema/src/supersync-http-contract.ts)
- [Client device setup](https://github.com/super-productivity/super-productivity/blob/93d5249d51f4fcfb9ccaab14a89438ae52925a10/src/app/imex/sync/super-sync-connect/super-sync-connect.api.ts)
- [Account provisioning decision](../../docs/adr/0001-provision-private-sync-accounts.md)
- [Upstream tracking decision](../../docs/adr/0002-pin-the-upstream-compatibility-baseline.md)
