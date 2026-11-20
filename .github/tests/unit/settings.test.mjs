import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, memoryDatabase, testVault, tempDir } from './helpers.mjs';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const { createSettings } = await load('settings/store.mjs');
const { DEFINITIONS } = await load('settings/registry.mjs');
const { loadOrCreateKey, createVault, safeEqual, hmacSha256Hex } = await load('security/crypto.mjs');

async function make(options = {}) {
  return createSettings({ db: await memoryDatabase(), vault: await testVault(), options });
}

test('defaults apply when nothing is configured', async () => {
  const settings = await make();
  assert.equal(settings.get('schedule.cron'), '0 */6 * * *');
  assert.equal(settings.get('renovate.onboarding'), true);
  assert.equal(settings.get('general.accent_color'), null);
});

test('the app configuration wins and locks the setting', async () => {
  const settings = await make({ schedule: { cron: '15 2 * * *' } });
  assert.equal(settings.get('schedule.cron'), '15 2 * * *');
  assert.throws(() => settings.update({ 'schedule.cron': '0 1 * * *' }), /app configuration/);
  const entry = settings.describe().find((item) => item.key === 'schedule.cron');
  assert.equal(entry.locked, true);
  assert.equal(entry.source, 'options');
});

test('values from the web interface persist and null resets them', async () => {
  const settings = await make();
  settings.update({ 'schedule.interval_minutes': 90, 'general.theme': 'dark' });
  assert.equal(settings.get('schedule.interval_minutes'), 90);
  assert.equal(settings.describe().find((item) => item.key === 'general.theme').source, 'ui');
  settings.update({ 'general.theme': null });
  assert.equal(settings.get('general.theme'), 'auto');
});

test('invalid values are rejected with a reason', async () => {
  const settings = await make();
  assert.throws(() => settings.update({ 'schedule.cron': 'nonsense' }), /five fields/);
  assert.throws(() => settings.update({ 'schedule.interval_minutes': 1 }), /from 5 to 10080/);
  assert.throws(() => settings.update({ 'general.accent': 'pink' }), /one of/);
  assert.throws(() => settings.update({ 'general.timezone': 'Mars/Olympus' }), /time zone/);
  assert.throws(() => settings.update({ 'webhooks.public_url': 'ftp://x' }), /http/);
  assert.throws(() => settings.update({ 'no.such.key': 1 }), /Unknown setting/);
});

test('options-only settings cannot be changed in the interface', async () => {
  const settings = await make();
  assert.throws(() => settings.update({ 'advanced.insecure_tls': true }), /app configuration/);
});

test('secrets are encrypted at rest, hidden from the interface and kept when left blank', async () => {
  const db = await memoryDatabase();
  const settings = createSettings({ db, vault: await testVault() });
  settings.update({ 'renovate.github_com_token': 'ghp_secret' });
  assert.equal(settings.get('renovate.github_com_token'), 'ghp_secret');
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'renovate.github_com_token'").get().value;
  assert.doesNotMatch(stored, /ghp_secret/);
  const entry = settings.describe().find((item) => item.key === 'renovate.github_com_token');
  assert.equal(entry.value, null);
  assert.equal(entry.configured, true);
  settings.update({ 'renovate.github_com_token': '' });
  assert.equal(settings.get('renovate.github_com_token'), 'ghp_secret');
});

test('rows with secrets keep them by id when the interface sends them blank', async () => {
  const settings = await make();
  settings.update({ 'renovate.host_rules': [{ match_host: 'registry.example.com', token: 'abc' }] });
  const [row] = settings.get('renovate.host_rules');
  assert.match(row.id, /^[a-f0-9]{6}$/);
  const shown = settings.describe().find((item) => item.key === 'renovate.host_rules').value[0];
  assert.equal(shown.token, undefined);
  assert.equal(shown.token_set, true);
  settings.update({ 'renovate.host_rules': [{ id: row.id, match_host: 'registry.example.com', username: 'bot' }] });
  const [after] = settings.get('renovate.host_rules');
  assert.equal(after.token, 'abc');
  assert.equal(after.username, 'bot');
});

test('change listeners learn which keys changed', async () => {
  const settings = await make();
  const seen = [];
  settings.onChange((keys) => seen.push(...keys));
  settings.update({ 'webhooks.enabled': true });
  assert.deepEqual(seen, ['webhooks.enabled']);
});

test('an invalid value in the app configuration is ignored with a note', async () => {
  const settings = await make({ schedule: { cron: 'every day' } });
  assert.equal(settings.get('schedule.cron'), '0 */6 * * *');
  assert.match(settings.describe().find((item) => item.key === 'schedule.cron').optionError, /five fields/);
});

test('every definition has a unique key and a usable shape', () => {
  const keys = new Set();
  for (const definition of DEFINITIONS) {
    assert.ok(!keys.has(definition.key), `duplicate ${definition.key}`);
    keys.add(definition.key);
    if (definition.type === 'enum') assert.ok(definition.values?.length > 1, definition.key);
    if (definition.type === 'int') assert.ok(definition.min <= definition.max, definition.key);
    if (definition.type === 'records') assert.ok(definition.fields?.length, definition.key);
  }
});

test('the key file is created once and reused', (t) => {
  const file = path.join(tempDir(t), 'keys', 'secret.key');
  const first = loadOrCreateKey(file);
  assert.equal(first.length, 32);
  assert.deepEqual(loadOrCreateKey(file), first);
  assert.match(readFileSync(file, 'utf8'), /^[A-Za-z0-9+/=]+\n$/);
  const vault = createVault(first);
  assert.equal(vault.decrypt(vault.encrypt('hello')), 'hello');
  assert.throws(() => createVault(Buffer.alloc(32, 1)).decrypt(vault.encrypt('hello')));
});

test('signatures compare in constant time and match the reference value', () => {
  // Reference value from RFC 4231 style test vectors for HMAC-SHA256.
  assert.equal(
    hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog'),
    'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
  );
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('abc', 'abcd'));
});
