-- More git servers and sign-in by browser. SQLite cannot change a CHECK constraint, so the table is rebuilt
-- (the migration runner switches foreign keys off around this, as the SQLite documentation prescribes).
CREATE TABLE connections_new (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  -- github, gitlab, gitea, forgejo, bitbucket, bitbucket-server, azure, gerrit or scm-manager
  provider            TEXT NOT NULL,
  endpoint            TEXT,
  -- Bitbucket Cloud and Gerrit sign in with a user name and a password or token.
  username            TEXT,
  token_enc           TEXT NOT NULL,
  token_ref           TEXT,
  -- Sign-in through the browser (OAuth 2): the access token expires, the refresh token renews it.
  oauth_client_id     TEXT,
  refresh_enc         TEXT,
  token_expires_at    TEXT,
  account_login       TEXT,
  account_name        TEXT,
  avatar_url          TEXT,
  mode                TEXT NOT NULL DEFAULT 'selected' CHECK (mode IN ('all', 'selected')),
  include_patterns    TEXT NOT NULL DEFAULT '[]',
  exclude_patterns    TEXT NOT NULL DEFAULT '[]',
  skip_forks          INTEGER NOT NULL DEFAULT 1,
  skip_archived       INTEGER NOT NULL DEFAULT 1,
  extra_config        TEXT NOT NULL DEFAULT '{}',
  webhook_secret      TEXT NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  managed             INTEGER NOT NULL DEFAULT 0,
  last_sync_at        TEXT,
  last_sync_error     TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

INSERT INTO connections_new
  (id, name, provider, endpoint, token_enc, token_ref, account_login, account_name, avatar_url, mode, include_patterns,
   exclude_patterns, skip_forks, skip_archived, extra_config, webhook_secret, enabled, managed, last_sync_at,
   last_sync_error, created_at, updated_at)
SELECT id, name, provider, endpoint, token_enc, token_ref, account_login, account_name, avatar_url, mode, include_patterns,
   exclude_patterns, skip_forks, skip_archived, extra_config, webhook_secret, enabled, managed, last_sync_at,
   last_sync_error, created_at, updated_at
FROM connections;

DROP TABLE connections;
ALTER TABLE connections_new RENAME TO connections;
