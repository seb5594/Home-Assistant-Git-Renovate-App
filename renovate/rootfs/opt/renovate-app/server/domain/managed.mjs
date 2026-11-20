// Connections that are written in the app configuration (`connections:` in config.yaml). They are kept in
// step at every start: created when new, updated when changed, removed when gone. The web interface shows
// them read-only, so the configuration stays the single source of truth for them.
import { nowIso } from '../db/database.mjs';
import { getProvider } from '../providers/index.mjs';
import { log } from '../util/log.mjs';

export async function reconcileManagedConnections({ db, vault, connections, specs }) {
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
        log.warn(`The connection "${spec.name}" from the app configuration is skipped: a connection with that name was created in the interface`);
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
    } catch (error) {
      log.error(`The connection "${spec.name}" from the app configuration cannot be set up`, error);
    }
  }
}

/** A list written as comma or line separated text in the app configuration (or already a list). */
const toList = (value) => (Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/)).map((item) => String(item).trim()).filter(Boolean);

/** Turns the `connections` list of options.json into specs; entries that cannot work are reported and dropped. */
export function specsFromOptions(options) {
  const specs = [];
  for (const entry of options?.connections ?? []) {
    if (!entry?.name || !entry?.provider || !entry?.token) {
      log.warn('A connection in the app configuration needs a name, a type and a token and is skipped');
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
  return specs;
}
