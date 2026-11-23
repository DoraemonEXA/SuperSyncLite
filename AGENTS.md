# SuperSync Lite

SuperSync Lite is a SuperSync server for manually provisioned users syncing their own devices with the unmodified Super Productivity client. Use the latest stable TypeScript, run the server on Cloudflare Workers, and persist sync data in Cloudflare D1.

## API compatibility

- Target the full upstream server API, with public registration and upstream browser authentication replaced by administrator provisioning and TOTP sign-in. Use the released revision in `upstream.json` and support the client's **Server URL** and **Access Token** settings. Keep authenticated routes protected. Omit signup, verification emails, emailed login or recovery links, and SMTP configuration.
- For each endpoint change, check the upstream route and shared schema at the same revision. Match the method, path, authentication, encoding, field names, optional fields, status codes, and error bodies. The README gives an overview. The route handlers and schemas define what the client can send and receive. [Upstream README](https://github.com/super-productivity/super-productivity/blob/master/packages/super-sync-server/README.md) · [Server source](https://github.com/super-productivity/super-productivity/tree/master/packages/super-sync-server/src) · [HTTP contract](https://github.com/super-productivity/super-productivity/blob/master/packages/shared-schema/src/supersync-http-contract.ts)
- Preserve ordering, retry behavior, vector-clock conflict handling, and download cursors across devices. Store encrypted payloads as opaque values. Match upstream behavior for snapshots, restore, dataset deletion, and WebSocket notifications. [Server architecture](https://github.com/super-productivity/super-productivity/blob/master/packages/super-sync-server/docs/architecture.md)

## Workers and D1

- Declare D1 in the Wrangler configuration and generate Worker binding types with `wrangler types`. Keep the authentication encryption and signing secret in Worker secrets. Store encrypted per-user TOTP seeds in D1. [Workers TypeScript guide](https://developers.cloudflare.com/workers/languages/typescript/)
- Use versioned D1 migrations. Commit an accepted operation and its sequence number atomically, and enforce operation-ID uniqueness in D1 so concurrent Worker instances and retried uploads agree on the result. [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)

## Verification

Exercise changed routes through the Worker against a locally migrated D1 database. For sync changes, use two client IDs and check what the second device receives after an upload, a repeated upload, and concurrent edits. Compare responses with the upstream contract and record the upstream revision used when reporting compatibility.

## Agent skills

- **Issue tracker** — Read and write specs and tickets as [local Markdown under `.scratch/`](docs/agents/issue-tracker.md).
- **Triage** — Use the [project’s triage labels](docs/agents/triage-labels.md) when assigning a ticket status.
- **Domain docs** — Consult the [glossary and architecture decision record conventions](docs/agents/domain.md) when discussing sync terminology or design decisions.
