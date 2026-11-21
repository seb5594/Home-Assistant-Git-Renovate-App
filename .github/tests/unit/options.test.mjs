// Proves that the app configuration and the app agree: every option that config.yaml offers reaches the
// setting of the same name, exactly as Home Assistant delivers it in options.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, memoryDatabase, testVault } from './helpers.mjs';

const { DEFINITIONS, groupOf, nameOf } = await load('settings/registry.mjs');
const { createSettings } = await load('settings/store.mjs');

/** A valid value for every kind of setting, different from its default where possible. */
function sample(definition) {
  const special = {
    'general.timezone': 'Europe/Berlin', 'general.accent_color': '#aabbcc', 'schedule.cron': '5 4 * * 1', 'renovate.onboarding_preset': 'config:base',
    'renovate.git_author': 'Bot <bot@example.com>', 'renovate.config_file': 'renovate.json', 'advanced.ca_certificate': 'ca.pem',
    'advanced.github_client_id': 'abc123', 'webhooks.public_url': 'https://hooks.example.org',
  };
  if (definition.key in special) return special[definition.key];
  switch (definition.type) {
    case 'bool': return !definition.default;
    case 'int': return definition.min;
    case 'enum': return definition.values.find((value) => value !== definition.default);
    case 'secret': return 'secret-value';
    case 'url': return 'https://example.org';
    case 'list': return ['abc', 'def'];
    case 'records': return [Object.fromEntries(definition.fields.filter((field) => field.required || field.type !== 'secret').map((field) => [field.key, field.key === 'name' ? 'MY_VAR' : 'x.example']))];
    default: return 'sample';
  }
}

const withoutIds = (rows) => (Array.isArray(rows) ? rows.map((row) => (row && typeof row === 'object' ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'id')) : row)) : rows);

test('every setting can be set from the app configuration, and arrives unchanged and locked', async () => {
  for (const definition of DEFINITIONS) {
    const value = sample(definition);
    const options = { [groupOf(definition.key)]: { [nameOf(definition.key)]: value } };
    const settings = createSettings({ db: await memoryDatabase(), vault: await testVault(), options });
    assert.deepEqual(withoutIds(settings.get(definition.key)), value, `${definition.key} did not arrive as written`);
    const entry = settings.describe().find((item) => item.key === definition.key);
    assert.equal(entry.source, 'options', `${definition.key} is not marked as coming from the app configuration`);
    assert.equal(entry.locked, true, `${definition.key} is not locked`);
    assert.equal(entry.optionError, undefined, `${definition.key} was rejected: ${entry.optionError}`);
  }
});

test('the values of "unset" in options.json leave the setting to the web interface', async () => {
  for (const definition of DEFINITIONS.filter((candidate) => candidate.scope !== 'options-only')) {
    const unset = ['list', 'records'].includes(definition.type) ? [] : '';
    const settings = createSettings({ db: await memoryDatabase(), vault: await testVault(), options: { [groupOf(definition.key)]: { [nameOf(definition.key)]: unset } } });
    assert.equal(settings.describe().find((item) => item.key === definition.key).locked, false, `${definition.key}: an empty value must not lock the setting`);
  }
});

test('false and zero are real values, not "unset"', async () => {
  const settings = createSettings({ db: await memoryDatabase(), vault: await testVault(), options: { schedule: { run_on_start: false }, renovate: { pr_concurrent_limit: 0, onboarding: false } } });
  assert.equal(settings.get('renovate.pr_concurrent_limit'), 0);
  assert.equal(settings.get('renovate.onboarding'), false);
  assert.equal(settings.describe().find((item) => item.key === 'schedule.run_on_start').locked, true);
});

test('a new app configuration replaces the old one live, and settings that are no longer set fall back', async () => {
  const settings = createSettings({ db: await memoryDatabase(), vault: await testVault(), options: { schedule: { cron: '1 1 * * *' } } });
  const seen = [];
  settings.onChange((keys) => seen.push(keys.length));
  assert.equal(settings.get('schedule.cron'), '1 1 * * *');
  settings.reloadOptions({ schedule: { cron: '2 2 * * *' }, general: { theme: 'dark' } });
  assert.equal(settings.get('schedule.cron'), '2 2 * * *');
  assert.equal(settings.get('general.theme'), 'dark');
  settings.reloadOptions({});
  assert.equal(settings.get('schedule.cron'), '0 */6 * * *');
  assert.equal(settings.get('general.theme'), 'auto');
  assert.equal(seen.length, 2, 'listeners are told after every reload');
});

test('config.yaml offers exactly the options the registry knows', (t) => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../renovate/config.yaml');
  if (!existsSync(file)) return t.skip('config.yaml is not part of the image');
  const schema = readFileSync(file, 'utf8').split('schema:\n')[1];
  const offered = [];
  let group = null;
  for (const line of schema.split('\n')) {
    const top = /^ {2}(\w+):\s*$/.exec(line);
    const key = /^ {4}(\w+):/.exec(line);
    if (top) group = top[1];
    else if (key && group) offered.push(`${group}.${key[1]}`);
  }
  assert.deepEqual(offered.sort(), DEFINITIONS.map((definition) => definition.key).sort());
});
