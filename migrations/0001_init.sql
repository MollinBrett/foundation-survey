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
  reviewed       INTEGER NOT NULL DEFAULT 0,         -- 1 once the watchdog has looked at it
  audited        INTEGER NOT NULL DEFAULT 0,         -- 1 once the auditor has re-checked a quarantine
  audit_note     TEXT
);
CREATE INDEX responses_submitted ON responses (submitted_at);
CREATE INDEX responses_reviewed ON responses (reviewed);
CREATE INDEX responses_fingerprint ON responses (text_fingerprint);

-- blocks: refuse sign-ins / submissions matching scope=value until expires_at.
-- Applied by the watchdog agent within limits enforced in code. A person can lift one early.
CREATE TABLE blocks (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,           -- provider | asn | country | source
  value       TEXT NOT NULL,
  hours       INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  evidence    TEXT,
  expires_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL,           -- agent:watchdog
  created_at  TEXT NOT NULL,
  lifted_by   TEXT,                    -- slack:<user id> if a person ended it early
  lifted_at   TEXT
);
CREATE INDEX blocks_expires ON blocks (expires_at);

-- quarantine_batches: one per watchdog quarantine call, so a batch can be restored as a unit.
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

-- audit_log: every quarantine, restore, block, lift, report, announcement and clean-up.
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,            -- agent:<role> | slack:<user id> | system
  action     TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX audit_log_at ON audit_log (at);

-- reports: reporter summaries. The latest one feeds the results page.
CREATE TABLE reports (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,            -- daily | final
  text       TEXT NOT NULL,
  themes     TEXT NOT NULL DEFAULT '[]', -- JSON [{title, summary, mentions}]
  created_at TEXT NOT NULL
);

-- announcements: launch and reminder posts. Drafted by the announcer agent, approved by the
-- announcement owner in Slack, published by the app when due.
CREATE TABLE announcements (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,         -- launch | reminder | last_call | thanks
  channel       TEXT NOT NULL,         -- x | discord | slack | mattermost
  text          TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,         -- ISO timestamp
  status        TEXT NOT NULL DEFAULT 'draft', -- draft | approved | posted | handed_off | skipped | failed
  decided_by    TEXT,                  -- slack:<user id>
  posted_at     TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX announcements_due ON announcements (status, scheduled_for);

-- agent_heartbeats: last time each agent called the API, for the self-check.
CREATE TABLE agent_heartbeats (
  role      TEXT PRIMARY KEY,
  last_seen TEXT NOT NULL
);

-- alerts: one row per problem per day, so a self-check alert is sent once, not every run.
CREATE TABLE alerts (
  key  TEXT NOT NULL,
  day  TEXT NOT NULL,
  PRIMARY KEY (key, day)
);

-- meta: small key/value flags (for example identities_purged_at).
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
