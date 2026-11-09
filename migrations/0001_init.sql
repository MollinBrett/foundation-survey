-- Identities and responses are deliberately NOT linked.
-- identities: one row per verified account that has submitted. No names, no handles,
-- no timestamps (a timestamp here could be joined to responses.submitted_at).
CREATE TABLE identities (
  id_hash   TEXT PRIMARY KEY,          -- HMAC(IDENTITY_PEPPER, provider:provider_user_id)
  provider  TEXT NOT NULL
);

-- responses: the answers. No identity column.
CREATE TABLE responses (
  id             TEXT PRIMARY KEY,     -- random
  channel        TEXT NOT NULL,        -- provider used to verify (x, discord, slack, github, mattermost)
  source         TEXT,                 -- ?src= tag from the launch post link, if any
  submitted_at   TEXT NOT NULL,        -- ISO timestamp
  asn            INTEGER,              -- network (ISP) number from Cloudflare, coarse, for flood detection
  country        TEXT,                 -- 2-letter country from Cloudflare
  answers        TEXT NOT NULL,        -- JSON
  text_fingerprint TEXT,               -- hash of normalized free text, to spot copy-paste
  status         TEXT NOT NULL DEFAULT 'accepted',  -- accepted | quarantined
  status_category TEXT,                -- spam | abuse | duplicate | coordinated | other
  status_reason  TEXT,
  reviewed       INTEGER NOT NULL DEFAULT 0          -- 1 once the watchdog has looked at it
);
CREATE INDEX responses_submitted ON responses (submitted_at);
CREATE INDEX responses_reviewed ON responses (reviewed);
CREATE INDEX responses_fingerprint ON responses (text_fingerprint);

-- blocks: refuse sign-ins / submissions matching scope=value until expires_at.
CREATE TABLE blocks (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,           -- provider | asn | country | source
  value       TEXT NOT NULL,
  reason      TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  approved_by TEXT NOT NULL,           -- Slack user ID of the human who approved
  created_at  TEXT NOT NULL
);

-- block_proposals: what the watchdog asked for. Only a human click turns one into a block.
CREATE TABLE block_proposals (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  value       TEXT NOT NULL,
  hours       INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  evidence    TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  decided_by  TEXT,
  created_at  TEXT NOT NULL,
  decided_at  TEXT
);

-- quarantine_batches: one per watchdog quarantine call, so a human can restore the batch.
CREATE TABLE quarantine_batches (
  id          TEXT PRIMARY KEY,
  response_ids TEXT NOT NULL,          -- JSON array
  category    TEXT NOT NULL,
  reason      TEXT NOT NULL,
  restored_by TEXT,
  created_at  TEXT NOT NULL
);

-- fallback_codes: one-time codes DMed by a bot for the handle + code path.
CREATE TABLE fallback_codes (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  handle_hash TEXT NOT NULL,           -- HMAC of provider:lowercased handle
  user_id     TEXT NOT NULL,           -- provider user ID; cleared on success, row pruned on expiry
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX fallback_codes_handle ON fallback_codes (handle_hash, created_at);

-- rate_limits: counters per hashed key per hour window. Old rows are pruned.
CREATE TABLE rate_limits (
  key          TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

-- audit_log: every quarantine, restore, block proposal, block and report.
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,            -- agent | slack:<user id> | system
  action     TEXT NOT NULL,
  detail     TEXT
);

-- reports: posted reporter summaries, so the final report is posted once.
CREATE TABLE reports (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,            -- daily | final
  created_at TEXT NOT NULL
);
