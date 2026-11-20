import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { load, tempDir } from './helpers.mjs';
import { createEnvironment } from './environment.mjs';

const { buildRenovateConfig, buildRenovateEnv, chunk } = await load('runs/config-builder.mjs');
const { resolveResources, autoProfile } = await load('runs/resources.mjs');
const { diagnose } = await load('runs/diagnose.mjs');
const { summarizeReport, totals } = await load('runs/report.mjs');
const { toEntry, createLogStore } = await load('runs/log-store.mjs');
const { isRepositoryEnabled, globToRegExp } = await load('domain/patterns.mjs');

const baseSettings = (overrides = {}) => ({
  'renovate.dry_run': 'off', 'renovate.onboarding': true, 'renovate.onboarding_preset': 'config:recommended',
  'renovate.require_config': 'required', 'renovate.git_author': null, 'renovate.default_extends': [], 'renovate.default_labels': [],
  'renovate.pr_concurrent_limit': null, 'renovate.pr_hourly_limit': null, 'renovate.host_rules': [], 'renovate.github_com_token': null,
  'advanced.renovate_log_level': 'info', 'advanced.extra_env': [], ...overrides,
});
const directories = { baseDir: '/w/base', cacheDir: '/d/cache', reportPath: '/w/report.json' };

test('the Renovate configuration is layered and the essentials cannot be overridden', () => {
  const config = buildRenovateConfig({
    connection: { extraConfig: { labels: ['from-connection'], platform: 'hacked', repositories: ['evil/repo'], prHourlyLimit: 5 } },
    renovate: { platform: 'gitea', endpoint: 'http://g/api/v1/' },
    repositories: ['sven/one'],
    settings: baseSettings({ 'renovate.default_labels': ['default'], 'renovate.pr_hourly_limit': 1, 'renovate.git_author': 'Bot <bot@example.com>', 'renovate.host_rules': [{ id: 'abc123', match_host: 'ghcr.io', token: 'x' }] }),
    directories,
    userConfig: { labels: ['from-file'], dryRun: 'full', binarySource: 'docker' },
  });
  assert.deepEqual(config.labels, ['from-connection']);
  assert.equal(config.prHourlyLimit, 5);
  assert.equal(config.gitAuthor, 'Bot <bot@example.com>');
  assert.deepEqual(config.hostRules, [{ matchHost: 'ghcr.io', token: 'x' }]);
  assert.equal(config.platform, 'gitea');
  assert.equal(config.endpoint, 'http://g/api/v1/');
  assert.deepEqual(config.repositories, ['sven/one']);
  assert.equal(config.autodiscover, false);
  assert.equal(config.binarySource, 'global');
  assert.equal(config.reportType, 'file');
  assert.equal(config.requireConfig, 'required');
  assert.deepEqual(config.onboardingConfig, { extends: ['config:recommended'] });
});

test('a preview run stays a preview', () => {
  const config = buildRenovateConfig({ connection: { extraConfig: {} }, renovate: { platform: 'github', endpoint: null }, repositories: ['a/b'], settings: baseSettings(), directories, userConfig: { dryRun: null }, dryRun: 'lookup' });
  assert.equal(config.dryRun, 'lookup');
  assert.equal(config.endpoint, undefined);
});

test('Renovate gets a minimal environment without the Supervisor token', () => {
  const env = buildRenovateEnv({
    processEnv: { PATH: '/bin', SUPERVISOR_TOKEN: 'secret', TZ: 'Europe/Berlin', SOMETHING: 'else' },
    connection: { token: 'tok' },
    renovate: { platform: 'github', endpoint: null },
    settings: baseSettings({ 'advanced.extra_env': [{ name: 'MY_FLAG', value: '1' }, { name: 'RENOVATE_TOKEN', value: 'stolen' }, { name: 'NODE_OPTIONS', value: '--evil' }] }),
    resources: { memoryLimitMb: 768 },
    files: { configFile: '/w/config.json', home: '/w/home' },
  });
  assert.equal(env.SUPERVISOR_TOKEN, undefined);
  assert.equal(env.SOMETHING, undefined);
  assert.equal(env.MY_FLAG, '1');
  assert.equal(env.RENOVATE_TOKEN, 'tok');
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=768');
  assert.equal(env.GITHUB_COM_TOKEN, 'tok');
  assert.equal(env.LOG_FORMAT, 'json');
  assert.equal(env.TZ, 'Europe/Berlin');
});

test('the token for release notes comes from the settings when the server is not github.com', () => {
  const env = buildRenovateEnv({ processEnv: {}, connection: { token: 'tok' }, renovate: { platform: 'gitea', endpoint: 'http://g/' }, settings: baseSettings({ 'renovate.github_com_token': 'ghp' }), resources: { memoryLimitMb: 512 }, files: { configFile: 'c', home: 'h' } });
  assert.equal(env.GITHUB_COM_TOKEN, 'ghp');
  const without = buildRenovateEnv({ processEnv: {}, connection: { token: 'tok' }, renovate: { platform: 'gitea', endpoint: 'http://g/' }, settings: baseSettings(), resources: { memoryLimitMb: 512 }, files: { configFile: 'c', home: 'h' } });
  assert.equal(without.GITHUB_COM_TOKEN, undefined);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('resource profiles follow the machine and respect overrides and ceilings', () => {
  assert.equal(autoProfile(1024), 'light');
  assert.equal(autoProfile(4096), 'balanced');
  assert.equal(autoProfile(16384), 'performance');
  const values = { 'resources.profile': 'auto', 'resources.run_timeout_minutes': 90 };
  assert.deepEqual(resolveResources(values, { totalMemoryMb: 1024, cpus: 4 }), { profile: 'light', automatic: true, maxConcurrentRuns: 1, memoryLimitMb: 512, batchSize: 3, cpuPriority: 15, timeoutMs: 5_400_000 });
  const big = resolveResources({ ...values, 'resources.profile': 'performance' }, { totalMemoryMb: 16384, cpus: 8 });
  assert.equal(big.maxConcurrentRuns, 2);
  const single = resolveResources({ ...values, 'resources.profile': 'performance' }, { totalMemoryMb: 16384, cpus: 1 });
  assert.equal(single.maxConcurrentRuns, 1);
  const capped = resolveResources({ ...values, 'resources.profile': 'performance', 'resources.memory_limit_mb': 8000 }, { totalMemoryMb: 2048, cpus: 4 });
  assert.equal(capped.memoryLimitMb, 1228);
});

test('repository rules: mode, patterns, archived, forks and manual overrides', () => {
  const rule = (extra = {}) => ({ mode: 'all', skip_forks: 1, skip_archived: 1, include_patterns: [], exclude_patterns: [], ...extra });
  const repo = (extra = {}) => ({ full_name: 'sven/ha-config', present: 1, can_push: 1, is_fork: 0, is_archived: 0, override_enabled: null, ...extra });
  assert.equal(isRepositoryEnabled(rule(), repo()), true);
  assert.equal(isRepositoryEnabled(rule({ mode: 'selected' }), repo()), false);
  assert.equal(isRepositoryEnabled(rule({ mode: 'selected' }), repo({ override_enabled: 1 })), true);
  assert.equal(isRepositoryEnabled(rule(), repo({ override_enabled: 0 })), false);
  assert.equal(isRepositoryEnabled(rule(), repo({ is_archived: 1 })), false);
  assert.equal(isRepositoryEnabled(rule({ skip_archived: 0 }), repo({ is_archived: 1 })), true);
  assert.equal(isRepositoryEnabled(rule(), repo({ is_fork: 1 })), false);
  assert.equal(isRepositoryEnabled(rule(), repo({ can_push: 0 })), false);
  assert.equal(isRepositoryEnabled(rule(), repo({ present: 0, override_enabled: 1 })), false);
  assert.equal(isRepositoryEnabled(rule({ include_patterns: ['sven/ha-*'] }), repo()), true);
  assert.equal(isRepositoryEnabled(rule({ include_patterns: ['other/*'] }), repo()), false);
  assert.equal(isRepositoryEnabled(rule({ exclude_patterns: ['**/ha-config'] }), repo()), false);
  assert.ok(globToRegExp('a/*').test('a/b'));
  assert.ok(!globToRegExp('a/*').test('a/b/c'));
  assert.ok(globToRegExp('a/**').test('a/b/c'));
  assert.ok(globToRegExp('A/B?').test('a/bc'));
});

test('Renovate log lines become compact entries', () => {
  const line = JSON.stringify({ level: 40, msg: 'Something', time: '2026-11-20T10:00:00.000Z', repository: 'o/r', branch: 'renovate/x', hostname: 'vm', err: { message: 'boom', stack: 'long' } });
  assert.deepEqual(toEntry(line), { t: Date.parse('2026-11-20T10:00:00.000Z'), l: 'warn', m: 'Something', r: 'o/r', x: { branch: 'renovate/x', error: 'boom' } });
  assert.equal(toEntry('plain words', 'error', 5).l, 'error');
  assert.equal(toEntry('   '), null);
  assert.equal(toEntry('{broken', 'info', 1).m, '{broken');
});

test('logs are read by offset, filtered by level and capped in size', (t) => {
  const dir = tempDir(t);
  const emitted = [];
  const store = createLogStore({ dir, maxBytes: 600, emit: (id, entry) => emitted.push(entry.m) });
  t.after(() => store.remove(1));
  const writer = store.open(1);
  for (const [l, m] of [['info', 'one'], ['warn', 'two'], ['error', 'three'], ['info', 'four']]) writer.write({ t: 1, l, m });
  const first = store.read(1, { limit: 2 });
  assert.deepEqual(first.entries.map((e) => e.m), ['one', 'two']);
  const second = store.read(1, { offset: first.nextOffset });
  assert.deepEqual(second.entries.map((e) => e.m), ['three', 'four']);
  assert.deepEqual(store.read(1, { level: 'warn' }).entries.map((e) => e.m), ['two', 'three']);
  for (let index = 0; index < 20; index += 1) writer.write({ t: 1, l: 'info', m: `filler ${index}` });
  writer.close();
  const all = store.read(1, { limit: 1000 }).entries;
  assert.equal(all.filter((entry) => /size limit/.test(entry.m)).length, 1);
  assert.ok(emitted.includes('one'));
  assert.equal(store.read(99).entries.length, 0);
});

test('the report is reduced to pull requests, pending updates and problems', () => {
  const report = {
    repositories: {
      'o/r': {
        problems: [{ level: 40, msg: 'careful' }, { level: 50, msg: 'broken' }],
        branches: [
          { branchName: 'a', prNo: 1, result: 'pr-created', upgrades: [{ depName: 'x', currentVersion: '1', newVersion: '2', updateType: 'major' }] },
          { branchName: 'b', prNo: 2, result: 'pr-edited' },
          { branchName: 'c', prNo: 3, result: 'automerged' },
          { branchName: 'd', result: 'not-scheduled' },
        ],
        packageFiles: { npm: [{ deps: [{ updates: [{}] }, {}] }], docker: [{ deps: [{ updates: [{}] }] }] },
      },
    },
  };
  const summary = summarizeReport(report).get('o/r');
  assert.deepEqual({ ...summary, branches: summary.branches.length, problems: summary.problems.length }, { pending: 2, openPrs: 2, prsCreated: 1, prsUpdated: 1, automerged: 1, errors: 1, warnings: 1, problems: 2, branches: 4 });
  assert.equal(summary.branches[0].upgrades[0].to, '2');
  const detailed = summarizeReport({ repositories: { 'o/r': { problems: [{ level: 50, msg: 'Repository has unknown error', err: { message: 'Request failed with status code 404' } }] } } }).get('o/r');
  assert.equal(detailed.problems[0].message, 'Repository has unknown error: Request failed with status code 404');
  assert.deepEqual(totals(summarizeReport(report)), { repositories: 1, pending: 2, openPrs: 2, prsCreated: 1, prsUpdated: 1, automerged: 1, errors: 1, warnings: 1 });
  assert.equal(summarizeReport(null).size, 0);
});

test('known failures get a code, everything else stays generic', () => {
  const entry = (l, m) => ({ l, m });
  const base = { exitCode: 1, signal: null, timedOut: false };
  assert.equal(diagnose({ ...base, entries: [entry('error', 'Authentication failure: Bad credentials')] }), 'authentication');
  assert.equal(diagnose({ ...base, entries: [entry('error', 'getaddrinfo ENOTFOUND git.example')] }), 'network');
  assert.equal(diagnose({ ...base, entries: [entry('error', 'self-signed certificate in certificate chain')] }), 'tls');
  assert.equal(diagnose({ ...base, entries: [entry('warn', 'API rate limit exceeded')] }), 'rate_limit');
  assert.equal(diagnose({ ...base, entries: [entry('error', 'FATAL ERROR: heap out of memory')] }), 'out_of_memory');
  assert.equal(diagnose({ exitCode: null, signal: 'SIGKILL', timedOut: false, entries: [] }), 'out_of_memory');
  assert.equal(diagnose({ ...base, entries: [], timedOut: true }), 'timeout');
  assert.equal(diagnose({ ...base, entries: [entry('error', 'odd')] }), 'failed');
  assert.equal(diagnose({ exitCode: 0, signal: null, timedOut: false, entries: [entry('info', 'fine')] }), null);
});

test('a run executes Renovate in batches and records the outcome per repository', async (t) => {
  const env = await createEnvironment(t, { resources: { batchSize: 2 } });
  const connection = await env.connect();
  assert.equal(env.connections.enabledRepositoryNames(connection.id).length, 3);
  process.env.SUPERVISOR_TOKEN = 'must-not-leak';
  env.settings.update({ 'advanced.extra_env': [{ name: 'FAKE_DUMP', value: path.join(env.dir, 'dump.json') }] });
  const { run } = env.queue.enqueue({ connectionId: connection.id, trigger: 'manual' });
  const done = await env.finished(run.id);
  delete process.env.SUPERVISOR_TOKEN;

  assert.equal(done.status, 'succeeded');
  assert.equal(done.summary.totals.repositories, 3);
  assert.equal(done.summary.totals.prsCreated, 3);
  assert.equal(done.summary.totals.pending, 3);
  const dump = JSON.parse(readFileSync(path.join(env.dir, 'dump.json'), 'utf8'));
  assert.equal(dump.length, 2, 'three repositories with batch size two need two Renovate processes');
  assert.deepEqual(dump.map((call) => call.config.repositories.length), [2, 1]);
  assert.equal(dump[0].env.RENOVATE_TOKEN, 'tok');
  assert.equal(dump[0].env.SUPERVISOR_TOKEN, undefined);
  assert.equal(dump[0].config.platform, 'gitea');

  const repos = env.connections.repositories(connection.id);
  assert.ok(repos.every((repo) => repo.lastStatus === 'ok' && repo.openPrs === 1 && repo.lastRunId === run.id));
  const logged = env.logStore.read(run.id).entries.map((entry) => entry.m);
  assert.ok(logged.some((message) => /starts for 3 repositories/.test(message)));
  assert.ok(logged.includes('Repository finished'));
});

test('failures are diagnosed and cancelling stops the process', async (t) => {
  const env = await createEnvironment(t);
  const connection = await env.connect();
  const setMode = (mode) => env.settings.update({ 'advanced.extra_env': [{ name: 'FAKE_MODE', value: mode }] });

  setMode('auth');
  const failed = await env.finished(env.queue.enqueue({ connectionId: connection.id, trigger: 'manual' }).run.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'authentication');
  assert.equal(failed.exitCode, 1);

  setMode('oom');
  const killed = await env.finished(env.queue.enqueue({ connectionId: connection.id, trigger: 'manual' }).run.id);
  assert.equal(killed.status, 'failed');
  assert.equal(killed.error, 'out_of_memory');

  setMode('plain-text');
  const plain = await env.finished(env.queue.enqueue({ connectionId: connection.id, trigger: 'manual' }).run.id);
  assert.equal(plain.error, 'failed');
  assert.ok(env.logStore.read(plain.id).entries.some((entry) => entry.l === 'error' && /without JSON/.test(entry.m)));

  setMode('sleep');
  const { run } = env.queue.enqueue({ connectionId: connection.id, trigger: 'manual' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(env.queue.get(run.id).status, 'running');
  env.queue.cancel(run.id);
  assert.equal((await env.finished(run.id)).status, 'cancelled');
  assert.throws(() => env.queue.cancel(run.id), /already finished/);
});

test('the time limit stops a run that takes too long', async (t) => {
  const env = await createEnvironment(t, { resources: { timeoutMs: 1000 } });
  const connection = await env.connect();
  env.settings.update({ 'advanced.extra_env': [{ name: 'FAKE_MODE', value: 'sleep' }] });
  const done = await env.finished(env.queue.enqueue({ connectionId: connection.id, trigger: 'schedule' }).run.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.error, 'timeout');
});

test('requests for the same connection are merged while a run waits, and runs never overlap per connection', async (t) => {
  const env = await createEnvironment(t);
  const connection = await env.connect();
  env.settings.update({ 'advanced.extra_env': [{ name: 'FAKE_MODE', value: 'sleep' }] });
  const first = env.queue.enqueue({ connectionId: connection.id, trigger: 'manual', repositories: ['sven/one'] }).run;
  await new Promise((resolve) => setTimeout(resolve, 200));
  const second = env.queue.enqueue({ connectionId: connection.id, trigger: 'webhook', repositories: ['sven/one'] });
  const third = env.queue.enqueue({ connectionId: connection.id, trigger: 'webhook', repositories: ['sven/two'] });
  assert.equal(second.merged, false);
  assert.equal(third.merged, true);
  assert.equal(third.run.id, second.run.id);
  assert.deepEqual(third.run.scope, ['sven/one', 'sven/two']);
  assert.equal(env.queue.get(first.id).status, 'running');
  assert.equal(env.queue.get(second.run.id).status, 'queued', 'the second run waits for the first one of the same connection');
  const everything = env.queue.enqueue({ connectionId: connection.id, trigger: 'schedule' });
  assert.equal(everything.merged, true);
  assert.equal(everything.run.scope, null, 'a full run absorbs the repository list');
  env.queue.cancel(second.run.id);
  env.queue.cancel(first.id);
  await env.finished(first.id);
});

test('after a restart, running runs are marked interrupted and old runs are pruned', async (t) => {
  const env = await createEnvironment(t);
  const connection = await env.connect();
  const { run } = env.queue.enqueue({ connectionId: connection.id, trigger: 'manual' });
  await env.finished(run.id);
  env.db.prepare("INSERT INTO runs (connection_id, connection_name, trigger, status, queued_at) VALUES (?, 'x', 'manual', 'running', '2026-01-01T00:00:00Z')").run(connection.id);
  assert.equal(env.queue.recover(), 1);
  const interrupted = env.queue.list().find((entry) => entry.status === 'interrupted');
  assert.equal(interrupted.error, 'interrupted');
  assert.ok(env.logStore.read(interrupted.id).entries[0].m.includes('restarted'));
  assert.equal(env.queue.prune({ keepRuns: 100, keepDays: 30 }), 1, 'the run from January is older than 30 days');
  assert.equal(env.queue.prune({ keepRuns: 1, keepDays: 30 }), 0);
  assert.equal(env.queue.list().length, 1);
});

test('a missing user configuration file fails the run with a clear message', async (t) => {
  const env = await createEnvironment(t);
  const connection = await env.connect();
  env.settings.update({ 'renovate.config_file': 'missing.json' });
  const done = await env.finished(env.queue.enqueue({ connectionId: connection.id, trigger: 'manual' }).run.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error, /missing\.json cannot be used: the file does not exist/);
});

test('a connection without enabled repositories does nothing and says so', async (t) => {
  const env = await createEnvironment(t);
  const connection = await env.connect({ mode: 'selected', name: 'Empty' });
  const done = await env.finished(env.queue.enqueue({ connectionId: connection.id, trigger: 'manual' }).run.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.error, 'no_repositories');
});
