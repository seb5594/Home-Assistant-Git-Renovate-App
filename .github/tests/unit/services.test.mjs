import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';
import { createEnvironment, fakeFetch } from './environment.mjs';

const { createScheduler } = await load('scheduling/scheduler.mjs');
const { createWebhookIntake } = await load('webhooks/intake.mjs');
const { createHomeAssistant } = await load('ha/client.mjs');
const { createPublisher } = await load('ha/publisher.mjs');
const { hmacSha256Hex } = await load('security/crypto.mjs');

/** Timers and a clock the test advances by hand. */
function manualTime(start = Date.parse('2026-11-20T10:00:00Z')) {
  let now = start;
  const pending = [];
  return {
    now: () => now,
    timers: {
      setTimeout(fn, delay) {
        const timer = { fn, at: now + delay, unref() {} };
        pending.push(timer);
        return timer;
      },
      clearTimeout(timer) {
        const index = pending.indexOf(timer);
        if (index >= 0) pending.splice(index, 1);
      },
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        pending.sort((a, b) => a.at - b.at);
        const next = pending[0];
        if (!next || next.at > target) break;
        pending.shift();
        now = next.at;
        next.fn();
      }
      now = target;
    },
    get waiting() { return pending.length; },
  };
}

test('the scheduler fires on the cron expression and plans the next run', () => {
  const time = manualTime();
  let fired = 0;
  const scheduler = createScheduler({ getSchedule: () => ({ mode: 'cron', cron: '0 */6 * * *', intervalMinutes: 60, timeZone: 'UTC' }), trigger: () => { fired += 1; }, now: time.now, timers: time.timers });
  assert.equal(new Date(scheduler.reschedule()).toISOString(), '2026-11-20T12:00:00.000Z');
  time.advance(2 * 3600_000);
  assert.equal(fired, 1);
  assert.equal(new Date(scheduler.nextRunAt()).toISOString(), '2026-11-20T18:00:00.000Z');
  time.advance(12 * 3600_000);
  assert.equal(fired, 3);
});

test('interval mode, manual mode and invalid schedules', () => {
  const time = manualTime();
  let schedule = { mode: 'interval', cron: '', intervalMinutes: 30, timeZone: 'UTC' };
  let fired = 0;
  const scheduler = createScheduler({ getSchedule: () => schedule, trigger: () => { fired += 1; }, now: time.now, timers: time.timers });
  scheduler.reschedule();
  time.advance(95 * 60_000);
  assert.equal(fired, 3);
  schedule = { mode: 'manual', cron: '', intervalMinutes: 30, timeZone: 'UTC' };
  assert.equal(scheduler.reschedule(), null);
  assert.equal(time.waiting, 0, 'manual mode leaves no timer behind');
  schedule = { mode: 'cron', cron: 'garbage', intervalMinutes: 30, timeZone: 'UTC' };
  assert.equal(scheduler.reschedule(), null);
  scheduler.stop();
});

test('a failing trigger does not stop the schedule', () => {
  const time = manualTime();
  let calls = 0;
  const scheduler = createScheduler({ getSchedule: () => ({ mode: 'interval', cron: '', intervalMinutes: 10, timeZone: 'UTC' }), trigger: () => { calls += 1; throw new Error('nope'); }, now: time.now, timers: time.timers });
  scheduler.reschedule();
  time.advance(25 * 60_000);
  assert.equal(calls, 2);
});

async function webhookSetup(t) {
  const env = await createEnvironment(t);
  env.settings.update({ 'webhooks.enabled': true, 'webhooks.debounce_seconds': 30 });
  const connection = await env.connect();
  const time = manualTime();
  const intake = createWebhookIntake({ connections: env.connections, queue: env.queue, settings: env.settings, timers: time.timers });
  const secret = env.connections.getWebhookSecret(connection.id);
  const deliver = (payload, { event = 'push', sign = true, headers = {} } = {}) => {
    const rawBody = Buffer.from(JSON.stringify(payload));
    return intake.handle({
      connectionId: connection.id,
      rawBody,
      headers: { 'x-gitea-event': event, ...(sign ? { 'x-gitea-signature': hmacSha256Hex(secret, rawBody) } : {}), ...headers },
    });
  };
  // Keep the queue from starting a real run: the tests only look at what was queued.
  env.limits.maxConcurrentRuns = 0;
  return { env, connection, time, intake, deliver };
}

test('webhooks: signature, event kind and repository decide what happens', async (t) => {
  const { deliver, connection } = await webhookSetup(t);
  const push = { ref: 'refs/heads/main', repository: { full_name: 'sven/one', default_branch: 'main' }, sender: { login: 'someone' } };
  assert.equal(deliver(push, { sign: false }).status, 401);
  assert.equal(deliver({ repository: { full_name: 'sven/one' } }, { event: 'ping' }).status, 200);
  assert.equal(deliver({ ...push, ref: 'refs/heads/dev' }).body.ignored, 'event');
  assert.equal(deliver({ ...push, sender: { login: 'sven' } }).body.ignored, 'own-event');
  assert.equal(deliver({ ...push, repository: { full_name: 'other/repo', default_branch: 'main' } }).body.ignored, 'repository');
  assert.equal(deliver({ action: 'edited', issue: { title: 'Some issue' }, repository: push.repository, sender: { login: 'x' } }, { event: 'issues' }).body.ignored, 'issue');
  const accepted = deliver(push);
  assert.deepEqual(accepted, { status: 202, body: { queued: true, repository: 'sven/one' } });
  void connection;
});

test('webhooks: events are collected and turned into one run after the debounce time', async (t) => {
  const { deliver, time, env, connection } = await webhookSetup(t);
  const repoEvent = (name) => ({ ref: 'refs/heads/main', repository: { full_name: name, default_branch: 'main' }, sender: { login: 'someone' } });
  deliver(repoEvent('sven/one'));
  time.advance(10_000);
  deliver(repoEvent('sven/two'));
  deliver(repoEvent('sven/one'));
  assert.equal(env.queue.list().length, 0, 'nothing is queued before the debounce time is over');
  time.advance(21_000);
  const runs = env.queue.list();
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].scope, ['sven/one', 'sven/two']);
  assert.equal(runs[0].trigger, 'webhook');
  assert.equal(runs[0].connectionId, connection.id);
});

test('webhooks: disabled, unknown connection and broken bodies are refused', async (t) => {
  const { env, intake, connection } = await webhookSetup(t);
  const secret = env.connections.getWebhookSecret(connection.id);
  const body = Buffer.from('not json');
  const headers = { 'x-gitea-signature': hmacSha256Hex(secret, body) };
  assert.equal(intake.handle({ connectionId: connection.id, rawBody: body, headers }).status, 400);
  assert.equal(intake.handle({ connectionId: 'nope', rawBody: body, headers }).status, 404);
  env.settings.update({ 'webhooks.enabled': false });
  assert.equal(intake.handle({ connectionId: connection.id, rawBody: body, headers }).status, 404);
});

test('connections: creation checks the token, sync tracks disappearing repositories and secrets stay hidden', async (t) => {
  const env = await createEnvironment(t);
  const { connection, warnings } = await env.connections.create({ name: 'Home Gitea', provider: 'gitea', endpoint: 'http://g:3000', token: 'tok' });
  assert.deepEqual(warnings, []);
  assert.equal(connection.endpoint, 'http://g:3000/api/v1/');
  assert.equal(connection.accountLogin, 'sven');
  assert.equal(JSON.stringify(connection).includes('"tok"'), false);
  const stored = env.db.prepare('SELECT token_enc FROM connections').get().token_enc;
  assert.doesNotMatch(stored, /tok/);
  assert.equal(env.connections.getForRun(connection.id).token, 'tok');
  assert.equal(env.connections.repositories(connection.id).length, 3);
  assert.equal(env.connections.enabledRepositoryNames(connection.id).length, 0, 'selected mode starts with nothing switched on');

  env.connections.setBulkOverride(connection.id, ['sven/one'], 1);
  assert.deepEqual(env.connections.enabledRepositoryNames(connection.id), ['sven/one']);
  env.connections.update(connection.id, { mode: 'all', excludePatterns: ['sven/t*'] });
  assert.deepEqual(env.connections.enabledRepositoryNames(connection.id), ['sven/one']);
  env.connections.update(connection.id, { excludePatterns: [] });
  assert.equal(env.connections.enabledRepositoryNames(connection.id).length, 3);

  await assert.rejects(env.connections.create({ name: 'Home Gitea', provider: 'gitea', endpoint: 'http://g:3000', token: 'x' }), { code: 'name_taken' });
  await assert.rejects(env.connections.create({ name: '<b>', provider: 'gitea', endpoint: 'http://g', token: 'x' }), { code: 'invalid_name' });
  assert.throws(() => env.connections.update(connection.id, { extraConfig: { platform: 'x' } }), /managed by the app/);
  assert.throws(() => env.connections.update(connection.id, { includePatterns: 'nope' }), /patterns/);
});

test('connections: repositories that vanish from the server are marked, not deleted', async (t) => {
  const routes = { 'GET /user/repos': { body: [{ full_name: 'sven/one', permissions: { push: true } }] }, 'GET /user': { body: { id: 1, login: 'sven' } } };
  const env = await createEnvironment(t, { routes });
  const connection = await env.connect();
  routes['GET /user/repos'].body = [{ full_name: 'sven/two', permissions: { push: true } }];
  await env.connections.syncRepositories(connection.id);
  const repos = env.connections.repositories(connection.id);
  assert.deepEqual(repos.map((repo) => [repo.fullName, repo.present, repo.enabled]), [['sven/one', false, false], ['sven/two', true, true]]);
  assert.equal(env.connections.list()[0].repositoryCount, 1);
});

test('connections: a replacement token must belong to the same account', async (t) => {
  const routes = { 'GET /user/repos': { body: [] }, 'GET /user': { body: { id: 1, login: 'sven' } } };
  const env = await createEnvironment(t, { routes });
  const connection = await env.connect();
  routes['GET /user'].body = { id: 2, login: 'someone-else' };
  await assert.rejects(env.connections.replaceToken(connection.id, 'new'), { code: 'account_mismatch' });
  routes['GET /user'].body = { id: 1, login: 'sven' };
  await env.connections.replaceToken(connection.id, 'new');
  assert.equal(env.connections.getForRun(connection.id).token, 'new');
});

test('connections: webhooks are registered for every enabled repository and failures are reported', async (t) => {
  const routes = {
    'GET /user/repos': { body: [{ full_name: 'sven/one', permissions: { push: true } }, { full_name: 'sven/two', permissions: { push: true } }] },
    'GET /user': { body: { id: 1, login: 'sven' } },
    'GET /repos/sven/one/hooks': { body: [] },
    'POST /repos/sven/one/hooks': { status: 201, body: {} },
    'GET /repos/sven/two/hooks': { status: 403, body: { message: 'forbidden' } },
  };
  const env = await createEnvironment(t, { routes });
  const connection = await env.connect();
  const outcome = await env.connections.registerWebhooks(connection.id, { url: 'https://hooks.example/hooks/x' });
  assert.equal(outcome.created, 1);
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.failed[0].repository, 'sven/two');
  const posted = JSON.parse(env.fetcher.calls.find((call) => call.method === 'POST' && call.url.includes('/hooks')).body);
  assert.equal(posted.config.secret, env.connections.getWebhookSecret(connection.id));
  assert.equal(posted.type, 'gitea');
});

test('Home Assistant: no-ops without a token, calls the Core API with one', async () => {
  const idle = createHomeAssistant({ token: '' });
  assert.equal(idle.available, false);
  assert.equal(await idle.setState('sensor.x', 1), false);
  const fetcher = fakeFetch({ 'POST /states/sensor.x': { body: {} }, 'POST /events/renovate_run_finished': { body: {} }, 'POST /services/persistent_notification/create': { body: {} } });
  const ha = createHomeAssistant({ token: 'abc', baseUrl: 'http://supervisor/core/api', fetch: fetcher });
  assert.equal(await ha.setState('sensor.x', 5, { icon: 'mdi:x' }), true);
  assert.equal(fetcher.calls[0].headers.Authorization, 'Bearer abc');
  assert.deepEqual(JSON.parse(fetcher.calls[0].body), { state: '5', attributes: { icon: 'mdi:x' } });
  assert.equal(await ha.fireEvent('renovate_run_finished', { a: 1 }), true);
  assert.equal(await ha.notify({ id: 'n', title: 't', message: 'm' }), true);
});

test('Home Assistant: a finished run fires an event and, when asked, a notification', async (t) => {
  const env = await createEnvironment(t);
  const connection = await env.connect();
  const calls = [];
  const ha = { available: true, setState: async (...args) => calls.push(['state', ...args]), fireEvent: async (...args) => calls.push(['event', ...args]), notify: async (...args) => calls.push(['notify', ...args]) };
  env.settings.update({ 'home_assistant.failure_notification': true });
  const time = manualTime();
  const publisher = createPublisher({ ha, queue: env.queue, connections: env.connections, settings: env.settings, nextRunAt: () => null, timers: time.timers });
  publisher.start();
  env.settings.update({ 'advanced.extra_env': [{ name: 'FAKE_MODE', value: 'auth' }] });
  const run = env.queue.enqueue({ connectionId: connection.id, trigger: 'manual' }).run;
  await env.finished(run.id);
  await new Promise((resolve) => setImmediate(resolve));
  const event = calls.find((call) => call[0] === 'event');
  assert.equal(event[1], 'renovate_run_finished');
  assert.equal(event[2].status, 'failed');
  assert.ok(calls.some((call) => call[0] === 'notify' && /failed/.test(call[1].title)));
  await publisher.publishNow();
  const status = calls.filter((call) => call[0] === 'state' && call[1] === 'sensor.renovate_status').at(-1);
  assert.equal(status[2], 'error');
  assert.ok(calls.some((call) => call[1] === 'sensor.renovate_last_run'));
  publisher.stop();
});
