// The git servers added after the first four, and the sign-in through the browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROOT, load, tempDir } from './helpers.mjs';
import { createEnvironment, fakeFetch } from './environment.mjs';

const { bitbucket } = await load('providers/bitbucket.mjs');
const { bitbucketServer } = await load('providers/bitbucket-server.mjs');
const { azure } = await load('providers/azure.mjs');
const { gerrit } = await load('providers/gerrit.mjs');
const { scmManager } = await load('providers/scm-manager.mjs');
const { gitea } = await load('providers/gitea.mjs');
const { gitlab } = await load('providers/gitlab.mjs');
const { providers, describeProviders } = await load('providers/index.mjs');
const { beginBrowserLogin, finishBrowserLogin, parseRedirect, refreshAccessToken, REDIRECT_URI } = await load('providers/oauth.mjs');
const { buildRenovateEnv } = await load('runs/config-builder.mjs');

const collect = async (iterator) => {
  const all = [];
  for await (const item of iterator) all.push(item);
  return all;
};
const basic = (user, secret) => `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;

test('every provider has the full shape the rest of the app relies on', () => {
  for (const provider of Object.values(providers)) {
    for (const member of ['id', 'label', 'renovatePlatform', 'credentials', 'normalizeEndpoint', 'webUrl', 'tokenGuide', 'whoami', 'listRepositories', 'renovateConnection']) {
      assert.ok(provider[member] !== undefined, `${provider.id} lacks ${member}`);
    }
    assert.ok(['token', 'password'].includes(provider.credentials));
    assert.equal(typeof provider.beta, 'boolean');
    // The platform name must be one Renovate knows.
    assert.ok(['github', 'gitlab', 'gitea', 'forgejo', 'bitbucket', 'bitbucket-server', 'azure', 'gerrit', 'scm-manager'].includes(provider.renovatePlatform));
  }
  const byId = Object.fromEntries(describeProviders({}).map((entry) => [entry.id, entry]));
  assert.equal(byId.bitbucket.usernameRequired, true);
  assert.equal(byId.gerrit.credentials, 'password');
  assert.equal(byId.azure.beta, true);
  assert.equal(byId.github.beta, false);
  assert.equal(byId.gitea.browserLogin, true);
  assert.equal(byId.gitlab.browserLogin, true);
  assert.equal(byId.github.browserLogin, false);
  assert.equal(byId.bitbucket.webhooks, false);
  assert.equal(byId.github.webhooks, true);
});

test('Bitbucket Cloud: account, repositories across pages, fixed address', async () => {
  assert.equal(bitbucket.normalizeEndpoint(''), 'https://api.bitbucket.org/2.0/');
  assert.throws(() => bitbucket.normalizeEndpoint('https://git.example.org'), /fixed address/);
  const repo = (full_name, extra = {}) => ({ full_name, description: '', is_private: true, links: { html: { href: `https://bitbucket.org/${full_name}` } }, mainbranch: { name: 'main' }, ...extra });
  const fetcher = fakeFetch({
    'GET repositories?role=contributor': (url) => (url.includes('page=2') ? { body: { values: [repo('w/two', { parent: {} })] } } : { body: { values: [repo('w/one')], next: 'https://api.bitbucket.org/2.0/repositories?role=contributor&pagelen=100&page=2' } }),
    'GET /user': { body: { account_id: 'abc', display_name: 'Sven', links: { avatar: { href: 'https://a/1.png' } } } },
  });
  const ctx = { endpoint: 'https://api.bitbucket.org/2.0/', token: 'secret', username: 'sven', fetch: fetcher };
  const me = await bitbucket.whoami(ctx);
  assert.deepEqual({ login: me.login, name: me.name }, { login: 'sven', name: 'Sven' });
  assert.equal(fetcher.calls[0].headers.Authorization, basic('sven', 'secret'));
  assert.deepEqual((await collect(bitbucket.listRepositories(ctx))).map((item) => [item.fullName, item.isFork, item.defaultBranch]), [['w/one', false, 'main'], ['w/two', true, 'main']]);
  assert.deepEqual(bitbucket.renovateConnection({ username: 'sven' }), { platform: 'bitbucket', endpoint: null, username: 'sven', auth: 'password' });
});

test('Bitbucket Server: the account comes from the servlet, repositories are paged by start', async () => {
  assert.equal(bitbucketServer.normalizeEndpoint('bitbucket.example.com'), 'https://bitbucket.example.com/');
  assert.equal(bitbucketServer.normalizeEndpoint('https://git.example.com/bb/'), 'https://git.example.com/bb/');
  assert.throws(() => bitbucketServer.normalizeEndpoint(''), /required/);
  const page = (values, last, next) => ({ body: { values, isLastPage: last, nextPageStart: next } });
  const fetcher = fakeFetch({
    'GET /plugins/servlet/applinks/whoami': { headers: { 'x-ausername': 'renovate-bot' } },
    'GET /rest/api/1.0/users/renovate-bot': { body: { id: 5, displayName: 'Renovate Bot', avatarUrl: '/users/renovate-bot/avatar.png' } },
    'GET /rest/api/1.0/repos': (url) => (url.includes('start=1') ? page([{ slug: 'beta', project: { key: 'PRJ' }, public: true, archived: true }], true) : page([{ slug: 'alpha', project: { key: 'PRJ' }, origin: { slug: 'x' }, links: { self: [{ href: 'https://bb/projects/PRJ/repos/alpha/browse' }] } }], false, 1)),
  });
  const ctx = { endpoint: 'https://bb.example.com/', token: 't', fetch: fetcher };
  const me = await bitbucketServer.whoami(ctx);
  assert.deepEqual({ login: me.login, name: me.name, avatar: me.avatarUrl }, { login: 'renovate-bot', name: 'Renovate Bot', avatar: 'https://bb.example.com/users/renovate-bot/avatar.png' });
  assert.equal(fetcher.calls[0].headers.Authorization, 'Bearer t');
  const repos = await collect(bitbucketServer.listRepositories(ctx));
  assert.deepEqual(repos.map((item) => [item.fullName, item.isFork, item.isArchived, item.isPrivate]), [['PRJ/alpha', true, false, true], ['PRJ/beta', false, true, false]]);
  await assert.rejects(bitbucketServer.whoami({ ...ctx, fetch: fakeFetch({ 'GET /plugins/servlet/applinks/whoami': { body: '' } }) }), { code: 'provider_unauthorized' });
});

test('Azure DevOps: the organization is required, a PAT is sent as the password of an empty user', async () => {
  assert.equal(azure.normalizeEndpoint('https://dev.azure.com/my-org'), 'https://dev.azure.com/my-org/');
  assert.equal(azure.normalizeEndpoint('https://tfs.example.com/tfs/DefaultCollection/'), 'https://tfs.example.com/tfs/DefaultCollection/');
  assert.throws(() => azure.normalizeEndpoint('https://dev.azure.com'), /organization/);
  assert.equal(new URL(azure.tokenGuide('https://dev.azure.com/my-org/').url).pathname, '/my-org/_usersSettings/tokens');
  const fetcher = fakeFetch({
    'GET _apis/connectionData': { body: { authenticatedUser: { id: 'g-1', providerDisplayName: 'Sven S', isActive: true, properties: { Account: { $value: 'sven@example.com' } } } } },
    'GET _apis/git/repositories': { body: { value: [{ name: 'app', project: { name: 'Home' }, webUrl: 'https://dev.azure.com/o/Home/_git/app', defaultBranch: 'refs/heads/main' }, { name: 'old', project: { name: 'Home' }, isDisabled: true, isFork: true }] } },
  });
  const ctx = { endpoint: 'https://dev.azure.com/my-org/', token: 'pat', fetch: fetcher };
  const me = await azure.whoami(ctx);
  assert.deepEqual({ login: me.login, name: me.name }, { login: 'sven@example.com', name: 'Sven S' });
  assert.equal(fetcher.calls[0].headers.Authorization, basic('', 'pat'));
  const repos = await collect(azure.listRepositories(ctx));
  assert.deepEqual(repos.map((item) => [item.fullName, item.defaultBranch, item.isArchived, item.isFork]), [['Home/app', 'main', false, false], ['Home/old', null, true, true]]);
  await assert.rejects(azure.whoami({ ...ctx, fetch: fakeFetch({ 'GET _apis/connectionData': { body: {} } }) }), { code: 'provider_unauthorized' });
});

test('Gerrit: the magic prefix of its JSON is removed and projects are listed by name', async () => {
  assert.equal(gerrit.normalizeEndpoint('https://gerrit.example.com/a'), 'https://gerrit.example.com/');
  const prefixed = (object) => `)]}'\n${JSON.stringify(object)}`;
  const fetcher = {
    calls: [],
    async fn(url, init) {
      this.calls.push({ url, init });
      if (String(url).includes('a/accounts/self')) return new Response(prefixed({ _account_id: 1000, name: 'Renovate', username: 'renovate', email: 'r@example.com' }), { status: 200 });
      return new Response(prefixed({ 'my/project': { description: 'Mine', state: 'ACTIVE' }, 'frozen/project': { state: 'READ_ONLY' } }), { status: 200 });
    },
  };
  const ctx = { endpoint: 'https://gerrit.example.com/', token: 'http-pass', username: 'renovate', fetch: (...args) => fetcher.fn(...args) };
  const me = await gerrit.whoami(ctx);
  assert.deepEqual({ login: me.login, warnings: me.warnings }, { login: 'renovate', warnings: [] });
  assert.equal(fetcher.calls[0].init.headers.Authorization, basic('renovate', 'http-pass'));
  const repos = await collect(gerrit.listRepositories(ctx));
  assert.deepEqual(repos.map((item) => [item.fullName, item.canPush, item.isArchived]), [['my/project', true, false], ['frozen/project', false, true]]);
  assert.deepEqual(gerrit.renovateConnection({ endpoint: 'https://g/', username: 'renovate' }), { platform: 'gerrit', endpoint: 'https://g/', username: 'renovate', auth: 'password' });
});

test('SCM-Manager: the API sits below /scm, Git repositories only', async () => {
  assert.equal(scmManager.normalizeEndpoint('https://scm.example.org/scm/api/v2'), 'https://scm.example.org/scm/');
  const fetcher = fakeFetch({
    'GET /scm/api/v2/me': { body: { name: 'renovate', displayName: 'Renovate', mail: 'r@example.com' } },
    'GET /scm/api/v2/repositories': (url) => (url.includes('page=1')
      ? { body: { _embedded: { repositories: [{ namespace: 'ha', name: 'two', type: 'git', archived: true }] } } }
      : { body: { _embedded: { repositories: [{ namespace: 'ha', name: 'one', type: 'git' }, { namespace: 'ha', name: 'svn-thing', type: 'svn' }] }, _links: { next: { href: 'https://scm.example.org/scm/api/v2/repositories?pageSize=100&page=1' } } } }),
  });
  const ctx = { endpoint: 'https://scm.example.org/scm/', token: 'key', fetch: fetcher };
  assert.equal((await scmManager.whoami(ctx)).login, 'renovate');
  assert.deepEqual((await collect(scmManager.listRepositories(ctx))).map((item) => [item.fullName, item.isArchived]), [['ha/one', false], ['ha/two', true]]);
});

test('Renovate gets a user name and a password for the servers that need them, a token for the others', () => {
  const base = { processEnv: {}, settings: { 'advanced.extra_env': [], 'advanced.renovate_log_level': 'info', 'renovate.github_com_token': null }, resources: { memoryLimitMb: 512 }, files: { configFile: 'c', home: 'h' } };
  const userPass = buildRenovateEnv({ ...base, connection: { token: 'secret' }, renovate: { platform: 'bitbucket', endpoint: null, username: 'sven', auth: 'password' } });
  assert.equal(userPass.RENOVATE_USERNAME, 'sven');
  assert.equal(userPass.RENOVATE_PASSWORD, 'secret');
  assert.equal(userPass.RENOVATE_TOKEN, undefined);
  const token = buildRenovateEnv({ ...base, connection: { token: 'secret' }, renovate: { platform: 'azure', endpoint: 'https://dev.azure.com/o/', auth: 'token' } });
  assert.equal(token.RENOVATE_TOKEN, 'secret');
  assert.equal(token.RENOVATE_PASSWORD, undefined);
});

test('what the user pastes after the browser sign-in is understood in every form', () => {
  assert.deepEqual(parseRedirect('http://127.0.0.1:5594/callback?code=abc&state=xyz'), { code: 'abc', state: 'xyz', error: null });
  assert.deepEqual(parseRedirect('  http://127.0.0.1:5594/callback?state=xyz&code=a%2Bb#fragment '), { code: 'a+b', state: 'xyz', error: null });
  assert.deepEqual(parseRedirect('?code=abc'), { code: 'abc', state: null, error: null });
  assert.deepEqual(parseRedirect('justTheCode123'), { code: 'justTheCode123', state: null, error: null });
  assert.equal(parseRedirect('http://127.0.0.1:5594/callback?error=access_denied&error_description=No').error, 'No');
  assert.throws(() => parseRedirect('   '), /Paste the address/);
});

test('browser sign-in: PKCE, state, exchange and renewal against a Gitea', async () => {
  const web = 'http://gitea:3000';
  const started = beginBrowserLogin(gitea, { endpoint: `${web}/api/v1/`, clientId: 'client-1' });
  const url = new URL(started.authorizeUrl);
  assert.equal(`${url.origin}${url.pathname}`, `${web}/login/oauth/authorize`);
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(started.verifier).digest('base64url'));
  assert.equal(url.searchParams.get('state'), started.state);
  assert.match(url.searchParams.get('scope'), /write:repository/);
  assert.ok(started.verifier.length >= 43 && started.verifier.length <= 128);

  let received;
  const fetcher = fakeFetch({ 'POST /login/oauth/access_token': (u, init) => { received = new URLSearchParams(String(init.body)); return { body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } }; } });
  const ctx = { endpoint: `${web}/api/v1/`, fetch: fetcher };
  const tokens = await finishBrowserLogin(gitea, ctx, { clientId: 'client-1', verifier: started.verifier, state: started.state, pasted: `${REDIRECT_URI}?code=the-code&state=${started.state}` });
  assert.deepEqual({ at: tokens.accessToken, rt: tokens.refreshToken }, { at: 'at', rt: 'rt' });
  assert.ok(Date.parse(tokens.expiresAt) > Date.now() + 3_000_000);
  assert.deepEqual(Object.fromEntries(received), { grant_type: 'authorization_code', client_id: 'client-1', code: 'the-code', redirect_uri: REDIRECT_URI, code_verifier: started.verifier });

  await assert.rejects(finishBrowserLogin(gitea, ctx, { clientId: 'c', verifier: 'v', state: 'right', pasted: `${REDIRECT_URI}?code=x&state=wrong` }), { code: 'oauth_state_mismatch' });
  await assert.rejects(finishBrowserLogin(gitea, ctx, { clientId: 'c', verifier: 'v', state: 's', pasted: `${REDIRECT_URI}?error=access_denied` }), { code: 'oauth_denied' });

  const renewal = fakeFetch({ 'POST /login/oauth/access_token': (u, init) => { received = new URLSearchParams(String(init.body)); return { body: { access_token: 'at2', expires_in: 3600 } }; } });
  const renewed = await refreshAccessToken(gitea, { endpoint: `${web}/api/v1/`, fetch: renewal }, { clientId: 'client-1', refreshToken: 'rt' });
  assert.equal(renewed.accessToken, 'at2');
  assert.equal(renewed.refreshToken, 'rt', 'a server that does not rotate refresh tokens keeps the old one');
  assert.deepEqual(Object.fromEntries(received), { grant_type: 'refresh_token', client_id: 'client-1', refresh_token: 'rt' });

  const lab = new URL(beginBrowserLogin(gitlab, { endpoint: 'https://gitlab.example.com/api/v4/', clientId: 'x' }).authorizeUrl);
  assert.equal(`${lab.origin}${lab.pathname}`, 'https://gitlab.example.com/oauth/authorize');
  assert.equal(lab.searchParams.get('scope'), 'api write_repository');
  assert.throws(() => beginBrowserLogin(providers.github, { endpoint: 'https://api.github.com/', clientId: 'x' }), /no sign-in through the browser/);
});

test('a connection signed in through the browser renews its token before it is used', async (t) => {
  let issued = 0;
  const routes = {
    'POST /login/oauth/access_token': (url, init) => {
      const form = new URLSearchParams(String(init.body));
      if (form.get('refresh_token') === 'revoked') return { status: 400, body: { error: 'invalid_grant' } };
      issued += 1;
      return { body: { access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 3600 } };
    },
    'GET /user/repos': { body: [] },
    'GET /user': { body: { id: 1, login: 'sven', full_name: 'Sven', email: 's@example.com' } },
  };
  const env = await createEnvironment(t, { routes });
  const soon = new Date(Date.now() + 60_000).toISOString();
  const { connection } = await env.connections.create({ name: 'Browser', provider: 'gitea', endpoint: 'http://g:3000', token: 'access-0', oauth: { clientId: 'c1', refreshToken: 'refresh-0', expiresAt: soon } });
  assert.equal(connection.authMethod, 'browser');
  assert.equal(env.db.prepare('SELECT refresh_enc FROM connections').get().refresh_enc.startsWith('v1:'), true, 'the refresh token is encrypted too');

  await Promise.all([env.connections.ensureFreshToken(connection.id), env.connections.ensureFreshToken(connection.id)]);
  assert.equal(issued, 1, 'two requests at once renew once: a rotating refresh token can be used only one time');
  assert.equal(env.connections.getForRun(connection.id).token, 'access-1');
  await env.connections.ensureFreshToken(connection.id);
  assert.equal(issued, 1, 'a token that is valid for an hour is left alone');

  env.db.prepare("UPDATE connections SET token_expires_at = ?, refresh_enc = ? WHERE id = ?").run(soon, env.vault.encrypt('revoked'), connection.id);
  await assert.rejects(env.connections.ensureFreshToken(connection.id), { code: 'oauth_expired' });
  // A plain token is never touched.
  const plain = (await env.connect({ name: 'Plain' }));
  await env.connections.ensureFreshToken(plain.id);
  assert.equal(env.connections.get(plain.id).authMethod, 'token');
});

test('a run renews the token first and reports an expired sign-in with its code', async (t) => {
  const routes = {
    'POST /login/oauth/access_token': { status: 400, body: { error: 'invalid_grant' } },
    'GET /user/repos': { body: [{ full_name: 'sven/one', permissions: { push: true } }] },
    'GET /user': { body: { id: 1, login: 'sven', full_name: 'Sven', email: 's@example.com' } },
  };
  const env = await createEnvironment(t, { routes });
  const valid = new Date(Date.now() + 3_600_000).toISOString();
  const { connection } = await env.connections.create({ name: 'Browser', provider: 'gitea', endpoint: 'http://g:3000', token: 'a', mode: 'all', oauth: { clientId: 'c1', refreshToken: 'r', expiresAt: valid } });
  assert.deepEqual(env.connections.enabledRepositoryNames(connection.id), ['sven/one']);
  // Time passes: the token is about to expire and the server no longer accepts the refresh token.
  env.db.prepare('UPDATE connections SET token_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), connection.id);
  const done = await env.finished(env.queue.enqueue({ connectionId: connection.id, trigger: 'manual' }).run.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.error, 'oauth_expired');
});

test('connections of servers with a user name store it, and need it', async (t) => {
  const routes = { 'GET /user': { body: { account_id: 'a', display_name: 'Sven' } }, 'GET repositories': { body: { values: [{ full_name: 'w/r', is_private: true }] } } };
  const env = await createEnvironment(t, { routes });
  await assert.rejects(env.connections.create({ name: 'Cloud', provider: 'bitbucket', token: 'pw' }), { code: 'username_required' });
  const { connection } = await env.connections.create({ name: 'Cloud', provider: 'bitbucket', token: 'pw', username: 'sven' });
  assert.equal(connection.username, 'sven');
  assert.equal(env.connections.getForRun(connection.id).username, 'sven');
  assert.equal(env.connections.repositories(connection.id)[0].fullName, 'w/r');
  await assert.rejects(env.connections.registerWebhooks(connection.id, { url: 'https://x' }), { code: 'webhooks_unsupported' });
});

test('the app keeps the old connections working and shows the new providers (end to end through the API)', async (t) => {
  const { createApp } = await load('app.mjs');
  const dir = tempDir(t);
  writeFileSync(path.join(dir, 'renovate-package.json'), JSON.stringify({ version: '44.0.0-test' }));
  const paths = { appRoot: APP_ROOT, ui: path.join(APP_ROOT, 'ui'), migrations: path.join(APP_ROOT, 'db'), data: dir, options: path.join(dir, 'options.json'), keyFile: path.join(dir, 'keys', 'secret.key'), runs: path.join(dir, 'runs'), cache: path.join(dir, 'cache'), work: path.join(dir, 'work'), userConfig: path.join(dir, 'config'), ssl: path.join(dir, 'ssl'), renovateBin: path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-renovate.mjs'), renovatePackage: path.join(dir, 'renovate-package.json') };
  const routes = {
    'POST /login/oauth/access_token': { body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
    'GET /user/repos': { body: [{ full_name: 'sven/one', permissions: { push: true } }] },
    'GET /user': { body: { id: 1, login: 'sven', full_name: 'Sven', email: 's@example.com' } },
  };
  const app = await createApp({ paths, options: {}, databaseFile: ':memory:', port: 0, allowedAddresses: null, fetch: fakeFetch(routes), processEnv: { PATH: process.env.PATH }, versionFile: path.join(dir, 'version') });
  await app.start();
  t.after(() => app.stop());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'X-Requested-With': 'renovate-ui', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const guide = (await call('GET', '/api/connect/browser-guide?provider=gitea&endpoint=http://gitea:3000')).data;
  assert.equal(guide.redirectUri, REDIRECT_URI);
  assert.equal(guide.appsUrl, 'http://gitea:3000/user/settings/applications');
  assert.equal((await call('GET', '/api/connect/browser-guide?provider=github')).data.error.code, 'unsupported');
  assert.equal((await call('POST', '/api/connect/browser/start', { provider: 'gitea', endpoint: 'http://gitea:3000' })).data.error.code, 'client_id_required');
  const start = (await call('POST', '/api/connect/browser/start', { provider: 'gitea', endpoint: 'http://gitea:3000', clientId: 'cid' })).data;
  assert.match(start.authorizeUrl, /^http:\/\/gitea:3000\/login\/oauth\/authorize\?/);
  const state = new URL(start.authorizeUrl).searchParams.get('state');
  const finished = await call('POST', '/api/connect/browser/finish', { flowId: start.flowId, pasted: `${REDIRECT_URI}?code=c&state=${state}` });
  assert.equal(finished.status, 200, JSON.stringify(finished.data));
  assert.equal(finished.data.account.login, 'sven');
  assert.equal(JSON.stringify(finished.data).includes('"at"'), false, 'tokens never go back to the browser');
  const created = await call('POST', '/api/connections', { credentialId: finished.data.credentialId, name: 'Passkey login', mode: 'all' });
  assert.equal(created.data.connection.authMethod, 'browser');
  assert.equal((await call('GET', `/api/connections/${created.data.connection.id}/webhook`)).data.supported, true);
});
