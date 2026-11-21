// Connections to git servers and the repositories they expose.
import { nowIso, parseJson, transaction } from '../db/database.mjs';
import { getProvider } from '../providers/index.mjs';
import { refreshAccessToken } from '../providers/oauth.mjs';
import { randomId, randomSecret } from '../security/crypto.mjs';
import { AppError, badRequest, conflict, notFound } from '../util/errors.mjs';
import { log } from '../util/log.mjs';
import { isRepositoryEnabled } from './patterns.mjs';

const NAME = /^[\p{L}\p{N} ._()-]{1,60}$/u;
const MAX_PATTERNS = 50;
// An access token that expires within this time is renewed before it is used.
const REFRESH_MARGIN_MS = 10 * 60_000;

function toConnection(row) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    endpoint: row.endpoint,
    username: row.username,
    authMethod: row.refresh_enc ? 'browser' : 'token',
    accountLogin: row.account_login,
    accountName: row.account_name,
    hasAvatar: Boolean(row.avatar_url),
    mode: row.mode,
    includePatterns: parseJson(row.include_patterns, []),
    excludePatterns: parseJson(row.exclude_patterns, []),
    skipForks: Boolean(row.skip_forks),
    skipArchived: Boolean(row.skip_archived),
    extraConfig: parseJson(row.extra_config, {}),
    enabled: Boolean(row.enabled),
    tokenName: row.token_ref,
    lastSyncAt: row.last_sync_at,
    lastSyncError: row.last_sync_error,
    createdAt: row.created_at,
  };
}

/** The shape the pattern helpers expect (database column names). */
const asRuleInput = (row) => ({
  mode: row.mode,
  skip_forks: row.skip_forks,
  skip_archived: row.skip_archived,
  include_patterns: parseJson(row.include_patterns, []),
  exclude_patterns: parseJson(row.exclude_patterns, []),
});

function toRepository(row, connectionRow) {
  return {
    id: row.id,
    fullName: row.full_name,
    description: row.description,
    htmlUrl: row.html_url,
    defaultBranch: row.default_branch,
    isPrivate: Boolean(row.is_private),
    isFork: Boolean(row.is_fork),
    isArchived: Boolean(row.is_archived),
    canPush: Boolean(row.can_push),
    present: Boolean(row.present),
    override: row.override_enabled,
    enabled: isRepositoryEnabled(asRuleInput(connectionRow), row),
    lastStatus: row.last_status,
    lastRunAt: row.last_run_at,
    lastRunId: row.last_run_id,
    openPrs: row.open_prs,
  };
}

function checkPatterns(label, value) {
  if (!Array.isArray(value) || value.length > MAX_PATTERNS || value.some((p) => typeof p !== 'string' || !p.trim() || p.length > 200)) {
    throw badRequest('invalid_patterns', `${label} must be a list of up to ${MAX_PATTERNS} patterns`);
  }
  return value.map((pattern) => pattern.trim());
}

function checkExtraConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('invalid_extra_config', 'Extra Renovate options must be a JSON object');
  const forbidden = ['token', 'username', 'password', 'platform', 'endpoint', 'repositories', 'autodiscover', 'hostRules', 'baseDir', 'cacheDir'].filter((key) => key in value);
  if (forbidden.length) throw badRequest('invalid_extra_config', `These options are managed by the app: ${forbidden.join(', ')}`);
  if (JSON.stringify(value).length > 20_000) throw badRequest('invalid_extra_config', 'Extra Renovate options are too large');
  return value;
}

export function createConnections({ db, vault, fetch: fetcher = fetch }) {
  const byId = db.prepare('SELECT * FROM connections WHERE id = ?');
  const byName = db.prepare('SELECT * FROM connections WHERE name = ?');
  const allRows = db.prepare('SELECT * FROM connections ORDER BY name COLLATE NOCASE');
  const repoRows = db.prepare('SELECT * FROM repositories WHERE connection_id = ? ORDER BY full_name COLLATE NOCASE');
  const countRows = db.prepare(`
    SELECT connection_id,
           COUNT(*) AS total,
           SUM(open_prs) AS open_prs
      FROM repositories WHERE present = 1 GROUP BY connection_id`);

  const row = (id) => {
    const found = byId.get(id);
    if (!found) throw notFound('The connection');
    return found;
  };

  const contextOf = (found) => ({ endpoint: found.endpoint, token: vault.decrypt(found.token_enc), username: found.username, fetch: fetcher });
  /** One renewal at a time per connection: servers that rotate refresh tokens refuse the second use of one. */
  const renewals = new Map();

  const api = {
    list() {
      const counts = new Map(countRows.all().map((entry) => [entry.connection_id, entry]));
      return allRows.all().map((found) => {
        const connection = toConnection(found);
        const enabled = repoRows.all(found.id).filter((repo) => isRepositoryEnabled(asRuleInput(found), repo)).length;
        return { ...connection, repositoryCount: counts.get(found.id)?.total ?? 0, enabledRepositoryCount: enabled, openPrs: counts.get(found.id)?.open_prs ?? 0 };
      });
    },

    get(id) {
      return toConnection(row(id));
    },

    /** The full row including the decrypted token, for the runner. Never send this to the browser. */
    getForRun(id) {
      const found = row(id);
      return { ...toConnection(found), token: vault.decrypt(found.token_enc), webhookSecret: found.webhook_secret, rule: asRuleInput(found) };
    },

    /**
     * Connections signed in through the browser have an access token that expires. This renews it when it is about
     * to, so a run never starts with a token that dies halfway.
     */
    async ensureFreshToken(id) {
      const found = row(id);
      if (!found.refresh_enc) return;
      const expires = found.token_expires_at ? Date.parse(found.token_expires_at) : 0;
      if (expires - Date.now() > REFRESH_MARGIN_MS) return;
      if (!renewals.has(id)) {
        const job = (async () => {
          try {
            const fresh = await refreshAccessToken(getProvider(found.provider), { endpoint: found.endpoint, fetch: fetcher }, { clientId: found.oauth_client_id, refreshToken: vault.decrypt(found.refresh_enc) });
            db.prepare('UPDATE connections SET token_enc = ?, refresh_enc = ?, token_expires_at = ?, updated_at = ? WHERE id = ?')
              .run(vault.encrypt(fresh.accessToken), vault.encrypt(fresh.refreshToken), fresh.expiresAt, nowIso(), id);
          } catch (error) {
            throw new AppError(401, 'oauth_expired', `The sign-in through the browser can no longer be renewed (${error.message}). Sign in again.`);
          } finally {
            renewals.delete(id);
          }
        })();
        renewals.set(id, job);
      }
      await renewals.get(id);
    },

    getWebhookSecret(id) {
      return row(id).webhook_secret;
    },

    avatarUrl(id) {
      return row(id).avatar_url;
    },

    /**
     * Checks a token against the server and describes the account. Used by the setup wizard before anything is stored.
     * @returns {Promise<{provider:string, endpoint:string, account:object}>}
     */
    async verify({ provider: providerId, endpoint, token, username }) {
      const provider = getProvider(providerId);
      const normalized = provider.normalizeEndpoint(endpoint);
      if (!token || typeof token !== 'string') throw badRequest('token_required', 'A token is required');
      const user = typeof username === 'string' ? username.trim() : '';
      if (provider.usernameRequired && !user) throw badRequest('username_required', 'The user name is required');
      const account = await provider.whoami({ endpoint: normalized, token: token.trim(), username: user || null, fetch: fetcher });
      return { provider: providerId, endpoint: normalized, username: user || null, account };
    },

    async create({ name, provider: providerId, endpoint, token, username = null, oauth = null, tokenName = null, mode = 'selected' }) {
      if (!NAME.test(name ?? '')) throw badRequest('invalid_name', 'The name may contain letters, digits, spaces and . _ ( ) -');
      if (byName.get(name)) throw conflict('name_taken', `A connection named "${name}" already exists`);
      if (!['all', 'selected'].includes(mode)) throw badRequest('invalid_mode', 'The mode must be "all" or "selected"');
      const checked = await api.verify({ provider: providerId, endpoint, token, username });
      const id = randomId(5);
      const now = nowIso();
      db.prepare(`INSERT INTO connections
        (id, name, provider, endpoint, username, token_enc, token_ref, oauth_client_id, refresh_enc, token_expires_at,
         account_login, account_name, avatar_url, mode, webhook_secret, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, name, providerId, checked.endpoint, checked.username, vault.encrypt(token.trim()), tokenName,
        oauth?.clientId ?? null, oauth?.refreshToken ? vault.encrypt(oauth.refreshToken) : null, oauth?.expiresAt ?? null,
        checked.account.login, checked.account.name, checked.account.avatarUrl, mode, randomSecret(), now, now,
      );
      await api.syncRepositories(id).catch((error) => log.warn(`First repository sync of "${name}" failed`, error));
      return { connection: api.get(id), warnings: checked.account.warnings };
    },

    update(id, patch) {
      const found = row(id);
      const sets = [];
      const values = [];
      const set = (column, value) => {
        sets.push(`${column} = ?`);
        values.push(value);
      };
      if ('name' in patch) {
        if (!NAME.test(patch.name ?? '')) throw badRequest('invalid_name', 'The name may contain letters, digits, spaces and . _ ( ) -');
        const clash = byName.get(patch.name);
        if (clash && clash.id !== id) throw conflict('name_taken', `A connection named "${patch.name}" already exists`);
        set('name', patch.name);
      }
      if ('mode' in patch) {
        if (!['all', 'selected'].includes(patch.mode)) throw badRequest('invalid_mode', 'The mode must be "all" or "selected"');
        set('mode', patch.mode);
      }
      if ('includePatterns' in patch) set('include_patterns', JSON.stringify(checkPatterns('Include patterns', patch.includePatterns)));
      if ('excludePatterns' in patch) set('exclude_patterns', JSON.stringify(checkPatterns('Exclude patterns', patch.excludePatterns)));
      if ('skipForks' in patch) set('skip_forks', patch.skipForks ? 1 : 0);
      if ('skipArchived' in patch) set('skip_archived', patch.skipArchived ? 1 : 0);
      if ('enabled' in patch) set('enabled', patch.enabled ? 1 : 0);
      if ('extraConfig' in patch) set('extra_config', JSON.stringify(checkExtraConfig(patch.extraConfig)));
      if (sets.length) {
        set('updated_at', nowIso());
        db.prepare(`UPDATE connections SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      }
      return api.get(id);
    },

    /** Replaces the token, for example after it expired. The account must stay the same. */
    async replaceToken(id, token) {
      const found = row(id);
      const checked = await api.verify({ provider: found.provider, endpoint: found.endpoint, token, username: found.username });
      if (checked.account.login !== found.account_login) {
        throw conflict('account_mismatch', `The token belongs to ${checked.account.login}, but this connection uses ${found.account_login}`);
      }
      db.prepare('UPDATE connections SET token_enc = ?, token_ref = NULL, oauth_client_id = NULL, refresh_enc = NULL, token_expires_at = NULL, updated_at = ? WHERE id = ?').run(vault.encrypt(token.trim()), nowIso(), id);
      return { connection: api.get(id), warnings: checked.account.warnings };
    },

    remove(id) {
      const found = row(id);
      db.prepare('DELETE FROM connections WHERE id = ?').run(id);
    },

    /** Reads the repository list from the git server and updates the local copy. */
    async syncRepositories(id) {
      await api.ensureFreshToken(id);
      const found = row(id);
      const provider = getProvider(found.provider);
      const seen = [];
      try {
        for await (const repo of provider.listRepositories(contextOf(found))) seen.push(repo);
      } catch (error) {
        db.prepare('UPDATE connections SET last_sync_error = ?, updated_at = ? WHERE id = ?').run(error.message, nowIso(), id);
        throw error;
      }
      transaction(db, () => {
        db.prepare('UPDATE repositories SET present = 0 WHERE connection_id = ?').run(id);
        const upsert = db.prepare(`INSERT INTO repositories
          (connection_id, full_name, description, html_url, default_branch, is_private, is_fork, is_archived, can_push, present)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT(connection_id, full_name) DO UPDATE SET
            description = excluded.description, html_url = excluded.html_url, default_branch = excluded.default_branch,
            is_private = excluded.is_private, is_fork = excluded.is_fork, is_archived = excluded.is_archived,
            can_push = excluded.can_push, present = 1`);
        for (const repo of seen) {
          upsert.run(id, repo.fullName, repo.description ?? null, repo.htmlUrl ?? null, repo.defaultBranch ?? null, +Boolean(repo.isPrivate), +Boolean(repo.isFork), +Boolean(repo.isArchived), +(repo.canPush ?? true));
        }
        db.prepare('UPDATE connections SET last_sync_at = ?, last_sync_error = NULL WHERE id = ?').run(nowIso(), id);
      });
      return seen.length;
    },

    repositories(id) {
      const found = row(id);
      return repoRows.all(id).map((repo) => toRepository(repo, found));
    },

    /** Names of the repositories Renovate should process for this connection. */
    enabledRepositoryNames(id) {
      const found = row(id);
      return repoRows.all(id).filter((repo) => isRepositoryEnabled(asRuleInput(found), repo)).map((repo) => repo.full_name);
    },

    setRepositoryOverride(id, repositoryId, override) {
      row(id);
      if (![null, 0, 1].includes(override)) throw badRequest('invalid_override', 'The override must be null, 0 or 1');
      const result = db.prepare('UPDATE repositories SET override_enabled = ? WHERE id = ? AND connection_id = ?').run(override, repositoryId, id);
      if (result.changes === 0) throw notFound('The repository');
    },

    /** Switches many repositories at once: `names` null means every repository the connection knows. */
    setBulkOverride(id, names, override) {
      row(id);
      if (![null, 0, 1].includes(override)) throw badRequest('invalid_override', 'The override must be null, 0 or 1');
      transaction(db, () => {
        if (names === null) {
          db.prepare('UPDATE repositories SET override_enabled = ? WHERE connection_id = ?').run(override, id);
          return;
        }
        const update = db.prepare('UPDATE repositories SET override_enabled = ? WHERE connection_id = ? AND full_name = ?');
        for (const name of names) update.run(override, id, name);
      });
    },

    /** Stores what the last run found, so the repository list can show it without opening the run. */
    recordRepositoryResult(connectionId, fullName, { runId, status, openPrs, at }) {
      db.prepare('UPDATE repositories SET last_run_id = ?, last_status = ?, last_run_at = ?, open_prs = ? WHERE connection_id = ? AND full_name = ?')
        .run(runId, status, at, openPrs, connectionId, fullName);
    },

    async registerWebhooks(id, { url, repositories }) {
      const found = row(id);
      const provider = getProvider(found.provider);
      if (!provider.webhooks) throw conflict('webhooks_unsupported', `${provider.label} connections cannot set up webhooks`);
      await api.ensureFreshToken(id);
      const context = contextOf(found);
      const names = repositories ?? api.enabledRepositoryNames(id);
      const outcome = { created: 0, updated: 0, failed: [] };
      for (const name of names) {
        try {
          const result = await provider.webhooks.register(context, name, { url, secret: found.webhook_secret, events: provider.webhookEvents });
          outcome[result] += 1;
        } catch (error) {
          outcome.failed.push({ repository: name, reason: error.message });
        }
      }
      return outcome;
    },

    context: contextOf,
    rawRow: row,
  };
  return api;
}
