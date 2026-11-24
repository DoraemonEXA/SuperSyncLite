-- Existing Workers and the recovery CLI advance token_version for full account revocation.
-- Only portal device revocations are excluded from the web session and Capture version.
ALTER TABLE users ADD COLUMN device_only_revocations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN account_version INTEGER
  GENERATED ALWAYS AS (token_version - device_only_revocations) VIRTUAL;
