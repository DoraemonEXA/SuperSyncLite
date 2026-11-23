CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  admin INTEGER NOT NULL DEFAULT 0,
  otp_secret TEXT NOT NULL,
  otp_step INTEGER NOT NULL DEFAULT -1,
  token_version INTEGER NOT NULL DEFAULT 0,
  replacement_seq INTEGER NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE operations (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, meta TEXT NOT NULL, received INTEGER NOT NULL, size INTEGER NOT NULL,
  op_type TEXT NOT NULL, causal INTEGER NOT NULL, full_clock TEXT, UNIQUE(user_id,seq)
);
CREATE INDEX boundaries ON operations(user_id,causal,seq);
CREATE INDEX restore_points ON operations(user_id,op_type,seq);
CREATE TABLE chunks (op TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE, part INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(op,part));
CREATE TABLE entities (user_id INTEGER NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, seq INTEGER NOT NULL,
  FOREIGN KEY(user_id,seq) REFERENCES operations(user_id,seq) ON DELETE CASCADE,
  PRIMARY KEY(user_id,entity_type,entity_id,seq));
CREATE INDEX entity_cleanup ON entities(user_id,seq);
CREATE TABLE devices (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, client TEXT NOT NULL, seen INTEGER NOT NULL, version TEXT, PRIMARY KEY(user_id,client));
CREATE TABLE live_sockets(socket_id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, seen INTEGER NOT NULL);
CREATE TABLE limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, until_ms INTEGER NOT NULL);
CREATE TABLE connect_requests (
  id TEXT PRIMARY KEY, poll_secret_hash TEXT NOT NULL, match_code TEXT NOT NULL, device_name TEXT NOT NULL,
  platform TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  token_version INTEGER, expires_at INTEGER NOT NULL
);
CREATE INDEX connect_expiry ON connect_requests(expires_at);
CREATE TABLE capture_keys(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, public_key TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, disabled_at INTEGER);
CREATE TABLE capture_grants(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, client_name TEXT NOT NULL, secret_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER, client_id TEXT, resource TEXT, refresh_hash TEXT, prev_refresh_hash TEXT, rotated_at INTEGER, refresh_expires_at INTEGER);
CREATE INDEX grants_user ON capture_grants(user_id);
CREATE TABLE capture_receipts(grant_id TEXT NOT NULL REFERENCES capture_grants(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(grant_id,fingerprint));
CREATE TABLE capture_daily(grant_id TEXT PRIMARY KEY REFERENCES capture_grants(id) ON DELETE CASCADE, count INTEGER NOT NULL, until_ms INTEGER NOT NULL);
CREATE TABLE capture_items(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,grant_id TEXT NOT NULL,ciphertext TEXT NOT NULL,task_id TEXT NOT NULL,created_at INTEGER NOT NULL,lease_device_id TEXT,lease_until INTEGER);
CREATE INDEX queue_order ON capture_items(user_id,created_at);
CREATE INDEX queue_grant ON capture_items(grant_id);
CREATE TABLE capture_connect_codes(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,code_hash TEXT UNIQUE NOT NULL,token_version INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE capture_auth(id TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,client_id TEXT NOT NULL,client_name TEXT NOT NULL,redirect_uri TEXT NOT NULL,code_challenge TEXT NOT NULL,resource TEXT NOT NULL,state TEXT NOT NULL,scope TEXT NOT NULL,code_hash TEXT UNIQUE,token_version INTEGER,expires_at INTEGER NOT NULL);
CREATE INDEX auth_expiry ON capture_auth(expires_at);
CREATE TABLE account_revision(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
INSERT INTO account_revision VALUES(1,0);
CREATE TABLE write_guard(valid INTEGER CONSTRAINT stale_revision CHECK(valid=1));
CREATE TRIGGER connect_requests_insert AFTER INSERT ON connect_requests BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER connect_requests_update AFTER UPDATE ON connect_requests BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER connect_requests_delete AFTER DELETE ON connect_requests BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER capture_auth_insert AFTER INSERT ON capture_auth BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER capture_auth_update AFTER UPDATE ON capture_auth BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER capture_auth_delete AFTER DELETE ON capture_auth BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER capture_keys_insert AFTER INSERT ON capture_keys BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER capture_keys_update AFTER UPDATE ON capture_keys BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER capture_keys_delete AFTER DELETE ON capture_keys BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER capture_items_insert AFTER INSERT ON capture_items BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER capture_items_update AFTER UPDATE ON capture_items BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER capture_items_delete AFTER DELETE ON capture_items BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER capture_connect_codes_insert AFTER INSERT ON capture_connect_codes BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER capture_connect_codes_update AFTER UPDATE ON capture_connect_codes BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER capture_connect_codes_delete AFTER DELETE ON capture_connect_codes BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER capture_grants_insert AFTER INSERT ON capture_grants BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER capture_grants_update AFTER UPDATE ON capture_grants BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER capture_grants_delete AFTER DELETE ON capture_grants BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER users_insert AFTER INSERT ON users BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER users_update AFTER UPDATE OF token_version ON users BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER users_delete AFTER DELETE ON users BEGIN UPDATE account_revision SET revision=revision+1 WHERE id=1; END;

CREATE TABLE sync_receipts(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, request TEXT NOT NULL, fingerprint TEXT NOT NULL,
  result TEXT NOT NULL, expires INTEGER NOT NULL,
  PRIMARY KEY(user_id,kind,request)
);
CREATE INDEX sync_receipts_expiry ON sync_receipts(expires);
