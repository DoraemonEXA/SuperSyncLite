# Pin the upstream compatibility baseline

Use the released Super Productivity client, server handlers and shared HTTP contract from the same upstream commit to define compatible behavior. The initial baseline is [v20.1.0 at `93d5249d51f4fcfb9ccaab14a89438ae52925a10`](https://github.com/super-productivity/super-productivity/releases/tag/v20.1.0). Pinning these together keeps an unreleased change on the upstream default branch from silently changing the acceptance criteria.

Use GitHub Actions to check for new stable releases every Monday at 01:17 UTC and on manual dispatch. Report the latest release and its difference from the verified baseline. A maintainer initiates an upgrade and advances the baseline after compatibility verification. The account provisioning and sign-in differences are documented in [ADR 0001](0001-provision-private-sync-accounts.md).
