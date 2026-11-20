// Resolves every setting from its sources (app configuration, web interface, default) and stores the
// values changed in the web interface. Secrets are encrypted before they reach the database.
import { DEFINITIONS, DEFINITION_BY_KEY, groupOf, nameOf } from './registry.mjs';
import { isUnset, normalizeValue } from './validate.mjs';
import { nowIso } from '../db/database.mjs';
import { badRequest } from '../util/errors.mjs';
import { log } from '../util/log.mjs';

const hasSecretFields = (definition) => definition.type === 'records' && definition.fields.some((f) => f.type === 'secret');
const isSecretDefinition = (definition) => definition.type === 'secret' || hasSecretFields(definition);

function fromOptions(options, key) {
  const value = options?.[groupOf(key)]?.[nameOf(key)];
  const empty = isUnset(value) || (Array.isArray(value) && value.length === 0);
  return empty ? undefined : value;
}

/** Rows of a records setting get ids; options-defined rows are numbered because nobody edits them in the UI. */
function withRowIds(definition, value) {
  return definition.type === 'records' ? value.map((row, index) => ({ id: `opt${index}`, ...row })) : value;
}

export function createSettings({ db, vault, options = {} }) {
  let optionValues = options;
  const listeners = new Set();
  const selectAll = db.prepare('SELECT key, value FROM settings');
  const upsert = db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  );
  const remove = db.prepare('DELETE FROM settings WHERE key = ?');

  function readStored() {
    const stored = new Map();
    for (const { key, value } of selectAll.all()) {
      const definition = DEFINITION_BY_KEY.get(key);
      if (!definition) continue;
      try {
        const raw = isSecretDefinition(definition) ? vault.decrypt(value) : value;
        stored.set(key, JSON.parse(raw));
      } catch (error) {
        log.warn(`Ignoring unreadable stored setting ${key}`, error);
      }
    }
    return stored;
  }

  /** @returns {Map<string, {value:any, source:'options'|'ui'|'default', optionError?:string}>} */
  function resolveAll() {
    const stored = readStored();
    const resolved = new Map();
    for (const definition of DEFINITIONS) {
      const entry = { value: definition.default ?? null, source: 'default' };
      const configured = fromOptions(optionValues, definition.key);
      if (configured !== undefined) {
        try {
          entry.value = withRowIds(definition, normalizeValue(definition, configured));
          entry.source = 'options';
        } catch (error) {
          entry.optionError = error.message;
          log.warn(`The app configuration value for ${definition.key} is ignored: ${error.message}`);
        }
      }
      if (entry.source === 'default' && definition.scope !== 'options-only' && stored.has(definition.key)) {
        entry.value = stored.get(definition.key);
        entry.source = 'ui';
      }
      resolved.set(definition.key, entry);
    }
    return resolved;
  }

  let cache = resolveAll();

  function refresh(changedKeys) {
    cache = resolveAll();
    for (const listener of listeners) listener(changedKeys, api);
  }

  /** The value shown to the browser: secrets never leave the server. */
  function publicValue(definition, value) {
    if (definition.type === 'secret') return null;
    if (!hasSecretFields(definition)) return value;
    return value.map((row) => Object.fromEntries(Object.entries(row).map(([key, field]) => {
      const secret = definition.fields.find((candidate) => candidate.key === key)?.type === 'secret';
      return secret ? [`${key}_set`, true] : [key, field];
    })));
  }

  const api = {
    /** The effective value of one setting. Secrets are returned in clear text: for server-side use only. */
    get(key) {
      const entry = cache.get(key);
      if (!entry) throw new Error(`Unknown setting ${key}`);
      return entry.value;
    },

    /** Effective values of all settings as a flat object. */
    values() {
      return Object.fromEntries([...cache].map(([key, entry]) => [key, entry.value]));
    },

    /** Everything the settings page needs: definitions, effective values, sources and locks. */
    describe() {
      return DEFINITIONS.map((definition) => {
        const entry = cache.get(definition.key);
        const locked = entry.source === 'options' || definition.scope === 'options-only';
        return {
          key: definition.key,
          group: groupOf(definition.key),
          type: definition.type,
          values: definition.values,
          min: definition.min,
          max: definition.max,
          fields: definition.fields?.map(({ key, type, required }) => ({ key, type, required: Boolean(required) })),
          patternHint: definition.patternHint,
          scope: definition.scope,
          advanced: Boolean(definition.advanced),
          default: definition.type === 'secret' ? null : (definition.default ?? null),
          value: publicValue(definition, entry.value),
          configured: definition.type === 'secret' ? Boolean(entry.value) : undefined,
          source: entry.source,
          locked,
          lockReason: entry.source === 'options' ? 'options' : definition.scope === 'options-only' ? 'options-only' : undefined,
          optionError: entry.optionError,
        };
      });
    },

    /**
     * Stores changes made in the web interface. `null` resets a setting to its default; for secrets an
     * empty string keeps the stored value.
     */
    update(patch) {
      const writes = [];
      for (const [key, raw] of Object.entries(patch ?? {})) {
        const definition = DEFINITION_BY_KEY.get(key);
        if (!definition) throw badRequest('unknown_setting', `Unknown setting ${key}`, { key });
        const entry = cache.get(key);
        if (definition.scope === 'options-only' || entry.source === 'options') {
          throw badRequest('setting_locked', `${key} is set in the app configuration`, { key });
        }
        if (raw === null) {
          writes.push({ key, remove: true });
          continue;
        }
        if (definition.type === 'secret' && raw === '') continue;
        let value = normalizeValue(definition, raw);
        if (hasSecretFields(definition)) value = keepSecrets(definition, entry.value, raw, value);
        writes.push({ key, value, secret: isSecretDefinition(definition) });
      }
      for (const write of writes) {
        if (write.remove) {
          remove.run(write.key);
        } else {
          const json = JSON.stringify(write.value);
          upsert.run(write.key, write.secret ? vault.encrypt(json) : json, nowIso());
        }
      }
      if (writes.length) refresh(writes.map((write) => write.key));
    },

    /** Applies a new options.json (after the app configuration was saved and the app restarted). */
    reloadOptions(next) {
      optionValues = next;
      refresh(DEFINITIONS.map((definition) => definition.key));
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return api;
}

/** Secret fields left blank in a submitted row keep the value stored for the row with the same id. */
function keepSecrets(definition, previous, submitted, normalized) {
  const before = new Map((previous ?? []).map((row) => [row.id, row]));
  return normalized.map((row, index) => {
    const old = before.get(submitted[index]?.id);
    const merged = { ...row };
    for (const field of definition.fields.filter((candidate) => candidate.type === 'secret')) {
      if (!merged[field.key] && old?.[field.key]) merged[field.key] = old[field.key];
    }
    return merged;
  });
}
