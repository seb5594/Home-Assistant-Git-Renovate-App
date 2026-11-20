-- A git server account the app talks to, with the token Renovate uses for it.
CREATE TABLE connections (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  provider            TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'gitea', 'forgejo')),
  endpoint            TEXT,
  token_enc           TEXT NOT NULL,
  -- Identifier of the token on the server, when the app created it and can revoke it again.
  token_ref           TEXT,
  account_login       TEXT,
  account_name        TEXT,
  avatar_url          TEXT,
  -- all: every repository the account can push to, narrowed by include and exclude patterns
  -- selected: only repositories that were switched on by hand
  mode                TEXT NOT NULL DEFAULT 'selected' CHECK (mode IN ('all', 'selected')),
  include_patterns    TEXT NOT NULL DEFAULT '[]',
  exclude_patterns    TEXT NOT NULL DEFAULT '[]',
  skip_forks          INTEGER NOT NULL DEFAULT 1,
  skip_archived       INTEGER NOT NULL DEFAULT 1,
  -- Renovate options added to every run of this connection (JSON object).
  extra_config        TEXT NOT NULL DEFAULT '{}',
  webhook_secret      TEXT NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  -- 1 when the connection is defined in the app configuration and may not be edited in the interface.
  managed             INTEGER NOT NULL DEFAULT 0,
  last_sync_at        TEXT,
  last_sync_error     TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE repositories (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id       TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  full_name           TEXT NOT NULL,
  description         TEXT,
  html_url            TEXT,
  default_branch      TEXT,
  is_private          INTEGER NOT NULL DEFAULT 0,
  is_fork             INTEGER NOT NULL DEFAULT 0,
  is_archived         INTEGER NOT NULL DEFAULT 0,
  can_push            INTEGER NOT NULL DEFAULT 1,
  -- NULL follows the rule of the connection, 1 forces the repository on, 0 forces it off.
  override_enabled    INTEGER CHECK (override_enabled IN (0, 1)),
  -- Cleared when the provider no longer lists the repository.
  present             INTEGER NOT NULL DEFAULT 1,
  last_run_id         INTEGER,
  last_status         TEXT,
  last_run_at         TEXT,
  open_prs            INTEGER,
  UNIQUE (connection_id, full_name)
);

CREATE INDEX repositories_by_connection ON repositories (connection_id, present);

CREATE TABLE runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id       TEXT REFERENCES connections(id) ON DELETE SET NULL,
  connection_name     TEXT NOT NULL,
  trigger             TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'webhook', 'startup')),
  -- JSON array of repository names; NULL means every enabled repository of the connection.
  scope               TEXT,
  dry_run             TEXT,
  status              TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  queued_at           TEXT NOT NULL,
  started_at          TEXT,
  finished_at         TEXT,
  exit_code           INTEGER,
  -- JSON: repositories, pull requests created and updated, warnings, errors.
  summary             TEXT,
  error               TEXT
);

CREATE INDEX runs_by_status ON runs (status);
CREATE INDEX runs_by_queue_time ON runs (queued_at);

CREATE TABLE settings (
  key                 TEXT PRIMARY KEY,
  value               TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
