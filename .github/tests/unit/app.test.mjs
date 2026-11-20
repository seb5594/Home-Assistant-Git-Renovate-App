import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROOT, load, tempDir } from './helpers.mjs';
import { fakeFetch, giteaRoutes } from './environment.mjs';

const { createApp } = await load('app.mjs');
const { hmacSha256Hex } = await load('security/crypto.mjs');
const { createRequestHandler, createRouter } = await load('http/router.mjs');

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const UI = { 'X-Requested-With': 'renovate-ui', 'Content-Type': 'application/json' };

async function startApp(t, { options = {}, routes = giteaRoutes() } = {}) {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, 'renovate-package.json'), JSON.stringify({ version: '44.0.0-test' }));
  writeFileSync(path.join(dir, 'version'), '2026.11.20\n');
  const paths = {
    appRoot: APP_ROOT, ui: path.join(APP_ROOT, 'ui'), migrations: path.join(APP_ROOT, 'db'), data: dir, options: path.join(dir, 'options.json'),
    keyFile: path.join(dir, 'keys', 'secret.key'), runs: path.join(dir, 'runs'), cache: path.join(dir, 'cache'), work: path.join(dir, 'work'),
    userConfig: path.join(dir, 'config'), ssl: path.join(dir, 'ssl'), renovateBin: path.join(fixtures, 'fake-renovate.mjs'), renovatePackage: path.join(dir, 'renovate-package.json'),
  };
  const providerFetch = fakeFetch(routes);
  const app = await createApp({ paths, options, databaseFile: ':memory:', port: 0, allowedAddresses: null, fetch: providerFetch, versionFile: path.join(dir, 'version'), processEnv: { PATH: process.env.PATH } });
  await app.start();
  t.after(() => app.stop());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body, headers = UI) => {
    const response = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, data, headers: response.headers };
  };
  return { app, base, call, providerFetch, dir };
}

const waitForRun = async (call, id) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { data } = await call('GET', `/api/runs/${id}`);
    if (!['queued', 'running'].includes(data.status)) return data;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('The run did not finish');
};

test('the API answers health, boot data and refuses requests without the CSRF header', async (t) => {
  const { call } = await startApp(t, { options: { general: { accent: 'custom', accent_color: '#112233' } } });
  assert.deepEqual((await call('GET', '/api/health')).data, { ok: true });
  const { data: boot } = await call('GET', '/api/boot');
  assert.equal(boot.version, '2026.11.20');
  assert.equal(boot.renovate.version, '44.0.0-test');
  assert.equal(boot.renovate.url, 'https://github.com/renovatebot/renovate/releases/tag/44.0.0-test');
  assert.equal(boot.general.accent, 'custom');
  assert.equal(boot.general.accentColor, '#112233');
  assert.deepEqual(boot.providers.map((provider) => provider.id), ['github', 'gitlab', 'gitea', 'forgejo', 'bitbucket', 'bitbucket-server', 'azure', 'gerrit', 'scm-manager']);
  const blocked = await call('POST', '/api/runs', {}, { 'Content-Type': 'application/json' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error.code, 'missing_request_header');
  assert.equal((await call('GET', '/api/nothing')).status, 404);
  assert.equal((await call('DELETE', '/api/health')).status, 405);
  assert.equal((await call('POST', '/api/runs', undefined, UI)).status, 409, 'no connection yet means nothing to run');
});

test('only the ingress gateway may reach the interface', async () => {
  const handler = createRequestHandler({ router: createRouter(), serveStatic: async () => false, allowedAddresses: ['172.30.32.2'] });
  const answer = async (url, address) => {
    const result = { headers: {} };
    const res = { headersSent: false, writeHead(status) { result.status = status; this.headersSent = true; }, end(body) { result.body = body; } };
    await handler({ url, method: 'GET', headers: {}, socket: { remoteAddress: address } }, res);
    return result.status;
  };
  assert.equal(await answer('/api/boot', '172.30.32.2'), 404, 'allowed addresses pass the check (the route does not exist in this router)');
  assert.equal(await answer('/api/boot', '172.30.33.5'), 403, 'another app on the same network is refused');
  assert.equal(await answer('/api/health', '172.30.33.5'), 404, 'the health check is exempt');
});

test('the wizard flow: verify a token, connect, pick repositories, run, read the result', async (t) => {
  const { call } = await startApp(t);
  const verify = await call('POST', '/api/connect/verify', { provider: 'gitea', endpoint: 'http://g:3000', token: 'tok' });
  assert.equal(verify.status, 200);
  assert.deepEqual({ login: verify.data.account.login, count: verify.data.repositoryCount, pushable: verify.data.pushableCount }, { login: 'sven', count: 3, pushable: 3 });
  assert.equal(JSON.stringify(verify.data).includes('"tok"'), false, 'the token never goes back to the browser');

  const created = await call('POST', '/api/connections', { credentialId: verify.data.credentialId, name: 'Home Gitea', selected: ['sven/one', 'sven/two'] });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.connection.id;
  assert.equal((await call('POST', '/api/connections', { credentialId: verify.data.credentialId, name: 'Again' })).data.error.code, 'expired', 'a credential can be used once');

  const { data: list } = await call('GET', '/api/connections');
  assert.equal(list[0].enabledRepositoryCount, 2);
  const { data: repositories } = await call('GET', `/api/connections/${id}/repositories`);
  assert.deepEqual(repositories.filter((repo) => repo.enabled).map((repo) => repo.fullName), ['sven/one', 'sven/two']);
  const third = repositories.find((repo) => repo.fullName === 'sven/three');
  assert.equal((await call('PATCH', `/api/connections/${id}/repositories/${third.id}`, { override: 1 })).status, 200);
  assert.equal((await call('POST', `/api/connections/${id}/repositories/bulk`, { names: ['sven/one'], override: 0 })).status, 200);

  const started = await call('POST', '/api/runs', { connectionId: id });
  assert.equal(started.data.run.status === 'queued' || started.data.run.status === 'running', true);
  const done = await waitForRun(call, started.data.run.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.summary.totals.repositories, 2);
  assert.equal(done.summary.repositories['sven/two'].branches[0].upgrades[0].to, '1.3.0');

  const { data: log } = await call('GET', `/api/runs/${done.id}/log?level=info&limit=100`);
  assert.ok(log.entries.some((entry) => entry.m === 'Repository finished'));
  const runs = await call('GET', '/api/runs');
  assert.equal(runs.data[0].summary.repositories, undefined, 'lists carry totals only');
  assert.equal((await call('GET', '/api/runs/999')).status, 404);
  assert.equal((await call('GET', '/api/status')).data.queued, 0);
});

test('the live log stream replays the stored log and ends when the run is finished', async (t) => {
  const { call, base } = await startApp(t);
  const verify = await call('POST', '/api/connect/verify', { provider: 'gitea', endpoint: 'http://g:3000', token: 'tok' });
  const { data: { connection } } = await call('POST', '/api/connections', { credentialId: verify.data.credentialId, name: 'Home Gitea', mode: 'all' });
  const { data: { run } } = await call('POST', '/api/runs', { connectionId: connection.id });
  await waitForRun(call, run.id);
  const response = await fetch(`${base}/api/runs/${run.id}/stream?from=0`);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /event: log/);
  assert.match(text, /Repository finished/);
  assert.match(text, /event: run\ndata: {"status":"succeeded"}/);
});

test('settings can be read and changed, locked ones are refused, errors are explained', async (t) => {
  const { call } = await startApp(t, { options: { schedule: { cron: '30 3 * * *' } } });
  const { data } = await call('GET', '/api/settings');
  assert.equal(data.settings.find((entry) => entry.key === 'schedule.cron').locked, true);
  assert.ok(data.resources.profile);
  const changed = await call('PUT', '/api/settings', { changes: { 'general.theme': 'dark', 'schedule.mode': 'interval' } });
  assert.equal(changed.data.settings.find((entry) => entry.key === 'general.theme').value, 'dark');
  assert.equal((await call('GET', '/api/boot')).data.general.theme, 'dark');
  const locked = await call('PUT', '/api/settings', { changes: { 'schedule.cron': '0 1 * * *' } });
  assert.equal(locked.status, 400);
  assert.equal(locked.data.error.code, 'setting_locked');
  assert.equal((await call('PUT', '/api/settings', { changes: { 'schedule.interval_minutes': 2 } })).data.error.code, 'invalid_setting');
});

test('connections defined in the app configuration are created, read-only and removed when they disappear', async (t) => {
  const { call, app } = await startApp(t, { options: { connections: [{ name: 'From options', provider: 'gitea', url: 'http://g:3000', token: 'tok', repositories: ['sven/two'], include: [], exclude: [] }] } });
  const { data: list } = await call('GET', '/api/connections');
  assert.equal(list.length, 1);
  assert.equal(list[0].managed, true);
  assert.deepEqual(app.connections.enabledRepositoryNames(list[0].id), ['sven/two']);
  assert.equal((await call('DELETE', `/api/connections/${list[0].id}`)).data.error.code, 'connection_managed');
  assert.equal((await call('PATCH', `/api/connections/${list[0].id}`, { name: 'x' })).status, 409);
});

test('webhook deliveries reach the app through the separate listener', async (t) => {
  const { call, app } = await startApp(t);
  const verify = await call('POST', '/api/connect/verify', { provider: 'gitea', endpoint: 'http://g:3000', token: 'tok' });
  const { data: { connection } } = await call('POST', '/api/connections', { credentialId: verify.data.credentialId, name: 'Home Gitea', mode: 'all' });
  const port = 41000 + Math.floor(Math.random() * 1000);
  await call('PUT', '/api/settings', { changes: { 'webhooks.enabled': true, 'webhooks.port': port, 'webhooks.public_url': 'https://hooks.example.org/', 'webhooks.debounce_seconds': 5 } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const { data: hook } = await call('GET', `/api/connections/${connection.id}/webhook`);
  assert.equal(hook.url, `https://hooks.example.org/hooks/${connection.id}`);
  const body = JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'sven/one', default_branch: 'main' }, sender: { login: 'other' } });
  const send = (signature) => fetch(`http://127.0.0.1:${port}/hooks/${connection.id}`, { method: 'POST', headers: { 'X-Gitea-Event': 'push', 'X-Gitea-Signature': signature }, body });
  assert.equal((await send('wrong')).status, 401);
  const good = await send(hmacSha256Hex(hook.secret, Buffer.from(body)));
  assert.equal(good.status, 202);
  assert.deepEqual(await good.json(), { queued: true, repository: 'sven/one' });
  assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);
  assert.equal(app.webhookServer.status().listening, true);
  await call('PUT', '/api/settings', { changes: { 'webhooks.enabled': false } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(app.webhookServer.status().listening, false);
});

test('the Gitea app of Home Assistant is found by its address, a wrong token is explained', async (t) => {
  const routes = { ...giteaRoutes(), 'GET db21ed7f-gitea:3000/api/v1/version': { body: { version: '1.22.0' } } };
  const { call } = await startApp(t, { routes });
  const { data } = await call('POST', '/api/connect/discover', {});
  assert.deepEqual(data.found, [{ url: 'http://db21ed7f-gitea:3000', version: '1.22.0' }]);
  const second = await startApp(t, { routes: { 'GET /user': { status: 401, body: { message: 'token is invalid' } } } });
  const rejected = await second.call('POST', '/api/connect/verify', { provider: 'gitea', endpoint: 'http://g:3000', token: 'bad' });
  assert.equal(rejected.status, 502);
  assert.equal(rejected.data.error.code, 'provider_unauthorized');
  assert.match(rejected.data.error.message, /rejected the token/);
});

test('the token guide is built for the chosen server', async (t) => {
  const { call } = await startApp(t);
  const { data } = await call('GET', '/api/connect/guide?provider=gitlab&endpoint=gitlab.example.com');
  assert.equal(data.endpoint, 'https://gitlab.example.com/api/v4/');
  assert.match(data.url, /^https:\/\/gitlab\.example\.com\/-\/user_settings\/personal_access_tokens\?/);
  assert.equal((await call('GET', '/api/connect/guide?provider=nope')).status, 400);
});

test('the app follows the app configuration live: connections appear, change and disappear, errors are shown, restarts are announced', async (t) => {
  // The more specific routes come first: the first matching route answers.
  const routes = {
    'GET api.github.com/user/repos': { body: [{ full_name: 'octo/one', permissions: { push: true } }] },
    'GET api.github.com/user': (url, init) => (init.headers.Authorization === 'Bearer bad' ? { status: 401, body: { message: 'Bad credentials' } } : { body: { id: 9, login: 'octo' } }),
    ...giteaRoutes(),
  };
  const { app, call, dir } = await startApp(t, { routes });
  const write = (options) => writeFileSync(path.join(dir, 'options.json'), JSON.stringify(options));
  const status = async () => (await call('GET', '/api/status')).data.configuration;
  const names = async () => (await call('GET', '/api/connections')).data.map((connection) => connection.name);

  assert.deepEqual(await names(), []);
  const github = { name: 'GitHub', provider: 'github', token: 'ghp_good' };
  write({ connections: [github], schedule: { cron: '7 7 * * *' } });
  assert.equal((await call('POST', '/api/configuration/reload')).data.changed, true);
  assert.deepEqual(await names(), ['GitHub']);
  assert.equal((await call('GET', '/api/connections')).data[0].managed, true);
  assert.deepEqual((await status()).problems, []);
  assert.equal(app.settings.get('schedule.cron'), '7 7 * * *', 'settings follow without a restart');
  assert.equal((await call('POST', '/api/configuration/reload')).data.changed, false, 'nothing changed, nothing to do');

  write({ connections: [{ ...github, token: 'bad' }, { name: 'No token', provider: 'gitea' }], schedule: { cron: '7 7 * * *' } });
  await call('POST', '/api/configuration/reload');
  const problems = (await status()).problems;
  assert.deepEqual(problems.map((problem) => problem.name).sort(), ['GitHub', 'No token']);
  assert.match(problems.find((problem) => problem.name === 'GitHub').message, /rejected the token/);

  write({ advanced: { extra_packages: ['python3'] } });
  await call('POST', '/api/configuration/reload');
  assert.deepEqual(await names(), [], 'a connection that left the configuration is removed');
  assert.equal((await status()).restartRequired, true, 'extra packages are installed by the start script');
  assert.deepEqual((await status()).problems, []);
});

test('the app notices a changed options.json by itself', async (t) => {
  const { call, dir } = await startApp(t);
  writeFileSync(path.join(dir, 'options.json'), JSON.stringify({ connections: [{ name: 'Watched', provider: 'gitea', url: 'http://g:3000', token: 'tok' }] }));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await call('GET', '/api/connections')).data.length) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual((await call('GET', '/api/connections')).data.map((connection) => connection.name), ['Watched']);
});

test('an app configuration the app cannot read is reported instead of being ignored silently', async (t) => {
  const { call, dir } = await startApp(t);
  const file = path.join(dir, 'options.json');
  writeFileSync(file, '{ this is not json');
  const result = await call('POST', '/api/configuration/reload');
  assert.equal(result.data.changed, false);
  const [problem] = result.data.configuration.problems;
  assert.equal(problem.name, 'options.json');
  assert.match(problem.message, /cannot be read: it is not valid JSON/);
  writeFileSync(file, JSON.stringify({ schedule: { cron: '9 9 * * *' } }));
  const fixed = await call('POST', '/api/configuration/reload');
  assert.equal(fixed.data.changed, true);
  assert.deepEqual(fixed.data.configuration.problems, []);
});
