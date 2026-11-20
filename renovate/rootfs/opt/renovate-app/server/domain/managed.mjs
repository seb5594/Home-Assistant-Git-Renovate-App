// Connections that are written in the app configuration (`connections:` in config.yaml). They are kept in
// step at every start: created when new, updated when changed, removed when gone. The web interface shows
// them read-only, so the configuration stays the single source of truth for them.
import { nowIso } from '../db/database.mjs';
import { getProvider } from '../providers/index.mjs';
import { log } from '../util/log.mjs';

/** @returns {Promise<Array<{name:string, ok:boolean, message?:string}>>} one entry per connection of the app configuration */
export async function reconcileManagedConnections({ db, vault, connections, specs }) {
  const results = [];
  const wanted = new Map(specs.map((spec) => [spec.name, spec]));

  for (const row of db.prepare('SELECT id, name FROM connections WHERE managed = 1').all()) {
    if (!wanted.has(row.name)) {
      db.prepare('DELETE FROM connections WHERE id = ?').run(row.id);
      log.info(`Removed the connection "${row.name}", which is no longer in the app configuration`);
    }
  }

  for (const spec of specs) {
    try {
      const existing = connections.findByName(spec.name);
      if (existing && !existing.managed) {
        const message = 'A connection with this name was created in the web interface. Rename one of them.';
        log.warn(`The connection "${spec.name}" from the app configuration is skipped: ${message}`);
        results.push({ name: spec.name, ok: false, message });
        continue;
      }
      let id = existing?.id;
      if (existing) {
        const sameToken = vault.decrypt(existing.token_enc) === spec.token;
        const endpoint = getProvider(spec.provider).normalizeEndpoint(spec.url);
        if (!sameToken || existing.provider !== spec.provider || existing.endpoint !== endpoint) {
          // The account is verified again with the new details before they replace the old ones.
          const checked = await connections.verify({ provider: spec.provider, endpoint: spec.url, token: spec.token });
          db.prepare('UPDATE connections SET provider = ?, endpoint = ?, token_enc = ?, account_login = ?, account_name = ?, avatar_url = ?, updated_at = ? WHERE id = ?')
            .run(spec.provider, checked.endpoint, vault.encrypt(spec.token), checked.account.login, checked.account.name, checked.account.avatarUrl, nowIso(), id);
        }
      } else {
        ({ connection: { id } } = await connections.create({ name: spec.name, provider: spec.provider, endpoint: spec.url, token: spec.token, managed: true }));
      }

      const explicit = spec.repositories.length > 0;
      db.prepare('UPDATE connections SET mode = ?, include_patterns = ?, exclude_patterns = ?, updated_at = ? WHERE id = ?')
        .run(explicit ? 'selected' : 'all', JSON.stringify(spec.include), JSON.stringify(spec.exclude), nowIso(), id);
      await connections.syncRepositories(id).catch((error) => log.warn(`Could not read the repositories of "${spec.name}"`, error));
      if (explicit) {
        connections.setBulkOverride(id, null, null);
        connections.setBulkOverride(id, spec.repositories, 1);
      }
      log.info(`Connection "${spec.name}" is ready (${connections.enabledRepositoryNames(id).length} repositories switched on)`);
      results.push({ name: spec.name, ok: true });
    } catch (error) {
      log.error(`The connection "${spec.name}" from the app configuration cannot be set up`, error);
      results.push({ name: spec.name, ok: false, message: error.message });
    }
  }
  return results;
}

/** A list written as comma or line separated text in the app configuration (or already a list). */
const toList = (value) => (Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/)).map((item) => String(item).trim()).filter(Boolean);

/** Turns the `connections` list of options.json into specs; entries that cannot work are reported as problems. */
export function specsFromOptions(options) {
  const specs = [];
  const problems = [];
  for (const [index, entry] of (options?.connections ?? []).entries()) {
    if (!entry?.name || !entry?.provider || !entry?.token) {
      const message = 'A connection needs a name, a server type and a token.';
      log.warn(`Connection ${index + 1} in the app configuration is skipped: ${message}`);
      problems.push({ name: entry?.name ?? `#${index + 1}`, message });
      continue;
    }
    specs.push({
      name: String(entry.name),
      provider: entry.provider,
      url: entry.url ?? '',
      token: String(entry.token),
      repositories: toList(entry.repositories),
      include: toList(entry.include),
      exclude: toList(entry.exclude),
    });
  }
  return { specs, problems };
}
