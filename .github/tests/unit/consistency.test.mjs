// Things that must never drift apart: the translations, the texts the code asks for, the settings registry,
// the generated configuration and the footer the author's projects share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROOT, load } from './helpers.mjs';

const { DEFINITIONS, GROUPS, groupOf } = await load('settings/registry.mjs');
const ui = path.join(APP_ROOT, 'ui');
const locale = (code) => JSON.parse(readFileSync(path.join(ui, `locales/${code}.json`), 'utf8'));
const en = locale('en');
const de = locale('de');

function* files(directory) {
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    if (statSync(file).isDirectory()) yield* files(file);
    else yield file;
  }
}

const hasText = (messages, key) => key in messages || `${key}_one` in messages || `${key}_other` in messages;

test('English and German have exactly the same texts, and none is empty', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(de).sort());
  for (const [key, value] of Object.entries(en)) {
    assert.ok(value.trim(), `English text of ${key} is empty`);
    assert.ok(de[key].trim(), `German text of ${key} is empty`);
    // Placeholders must survive translation.
    const names = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
    assert.equal(names(de[key]), names(value), `placeholders of ${key} differ`);
  }
});

test('every text the interface asks for exists', () => {
  const source = [...files(path.join(ui, 'js'))].map((file) => readFileSync(file, 'utf8')).join('\n');
  const missing = [...new Set([...source.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1]))].filter((key) => !hasText(en, key));
  assert.deepEqual(missing, []);
});

test('every setting has a name and an explanation in both languages, and every choice a label', () => {
  for (const definition of DEFINITIONS) {
    for (const messages of [en, de]) {
      assert.ok(messages[`settings.${definition.key}.label`], `label of ${definition.key}`);
      assert.ok(messages[`settings.${definition.key}.help`], `help of ${definition.key}`);
      // The actions of the update settings share one set of labels.
      for (const value of definition.values ?? []) assert.ok(messages[`settings.${definition.key}.${value}`] ?? messages[`settings.${groupOf(definition.key)}.action.${value}`], `${definition.key}.${value}`);
      for (const field of definition.fields ?? []) assert.ok(messages[`settings.${definition.key}.field.${field.key}`], `${definition.key}.${field.key}`);
    }
  }
  for (const group of GROUPS) {
    assert.ok(en[`settings.group.${group}`] && en[`settings.group.${group}.help`], group);
    assert.ok(DEFINITIONS.some((definition) => groupOf(definition.key) === group), `group ${group} is empty`);
  }
  assert.ok(DEFINITIONS.every((definition) => GROUPS.includes(groupOf(definition.key))));
});

test('every error code the server can report has a translation or an explicit fallback', () => {
  const codes = new Set();
  for (const file of files(path.join(APP_ROOT, 'server'))) {
    const code = readFileSync(file, 'utf8');
    for (const match of code.matchAll(/(?:badRequest|conflict|new (?:AppError|ProviderError))\(\s*(?:\d{3},\s*)?'([a-z_]+)'/g)) codes.add(match[1]);
  }
  // Codes whose message carries the useful detail (what exactly was invalid) are shown as the server wrote them.
  const detailCodes = new Set(['invalid_setting', 'invalid_extra_config', 'invalid_patterns', 'unknown_setting', 'unknown_provider', 'unsupported', 'invalid_mode', 'invalid_override', 'invalid_names', 'invalid_json', 'invalid_dry_run', 'no_avatar', 'body_too_large', 'method_not_allowed', 'missing_request_header']);
  const untranslated = [...codes].filter((code) => !detailCodes.has(code) && !(`error.${code}` in en));
  assert.deepEqual(untranslated, []);
});

test('the footer carries the shared credit, links and buttons', () => {
  const footer = readFileSync(path.join(ui, 'js/footer.mjs'), 'utf8');
  for (const expected of ['https://github.com/seb5594', 'Sebastian Schmidt', 'https://github.com/seb5594/Home-Assistant-Apps', 'https://paypal.me/seb5594', '☕ 🍺', '♥']) {
    assert.ok(footer.includes(expected), `footer lacks ${expected}`);
  }
  assert.match(en['footer.apps'], /More Home Assistant Apps/);
  assert.match(en['footer.support'], /Support my work/);
  assert.match(en['footer.made_with'] + en['footer.in_germany'], /Made with.*in Germany/);
});

test('the web interface ships its icon and a strict content security policy', () => {
  assert.ok(existsSync(path.join(ui, 'assets/icon.svg')));
  const html = readFileSync(path.join(ui, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<style|style=|onclick=|<script(?![^>]*src=)/, 'no inline code or styles, the policy forbids them');
  for (const file of files(path.join(ui, 'js'))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /\.innerHTML\s*=(?!\s*markup)/, `${path.basename(file)} writes HTML from strings`);
  }
});

test('config.yaml and the translations are generated from the registry (run tools/sync-config.mjs after changes)', (t) => {
  const tool = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tools/sync-config.mjs');
  if (!existsSync(tool)) return t.skip('the tools folder is not part of the image');
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', tool, '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
