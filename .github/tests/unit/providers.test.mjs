import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { github } = await load('providers/github.mjs');
const { gitlab } = await load('providers/gitlab.mjs');
const { gitea, forgejo } = await load('providers/gitea.mjs');
const { getProvider, describeProviders } = await load('providers/index.mjs');
const { requestJson } = await load('providers/http.mjs');
const { hmacSha256Hex } = await load('security/crypto.mjs');

/** A fetch double: routes are "METHOD url-substring" → response description or function. */
function fakeFetch(routes) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url: String(url), method, headers: init.headers, body: init.body });
    for (const [key, reply] of Object.entries(routes)) {
      const [routeMethod, fragment] = key.split(' ');
      if (routeMethod === method && String(url).includes(fragment)) {
        const value = typeof reply === 'function' ? reply(String(url), init) : reply;
        if (value instanceof Error) throw value;
        return new Response(value.body === undefined ? '' : JSON.stringify(value.body), { status: value.status ?? 200, headers: value.headers ?? {} });
      }
    }
    return new Response('{"message":"no route"}', { status: 404 });
  };
  fetcher.calls = calls;
  return fetcher;
}

test('endpoints are normalized to the API address Renovate expects', () => {
  assert.equal(github.normalizeEndpoint(''), 'https://api.github.com/');
  assert.equal(github.normalizeEndpoint('https://github.com'), 'https://api.github.com/');
  assert.equal(github.normalizeEndpoint('ghe.example.com'), 'https://ghe.example.com/api/v3/');
  assert.equal(github.normalizeEndpoint('https://ghe.example.com/api/v3/'), 'https://ghe.example.com/api/v3/');
  assert.equal(gitlab.normalizeEndpoint('gitlab.com'), 'https://gitlab.com/api/v4/');
  assert.equal(gitlab.normalizeEndpoint('https://git.example.org/gitlab'), 'https://git.example.org/gitlab/api/v4/');
  assert.equal(gitea.normalizeEndpoint('http://db21ed7f-gitea:3000'), 'http://db21ed7f-gitea:3000/api/v1/');
  assert.equal(gitea.normalizeEndpoint('https://codeberg.org/'), 'https://codeberg.org/api/v1/');
  assert.equal(gitea.normalizeEndpoint('https://git.example.org/api/v1'), 'https://git.example.org/api/v1/');
  assert.throws(() => gitea.normalizeEndpoint(''), /required/);
  assert.throws(() => gitea.normalizeEndpoint('ftp://x'), /http/);
});

test('token guides link to a pre-filled page of the right server', () => {
  const classic = new URL(github.tokenGuide('https://api.github.com/').url);
  assert.equal(classic.origin + classic.pathname, 'https://github.com/settings/tokens/new');
  assert.equal(classic.searchParams.get('scopes'), 'repo,workflow');
  const fine = new URL(github.tokenGuide('https://api.github.com/').alternativeUrl);
  assert.equal(fine.searchParams.get('contents'), 'write');
  const enterprise = new URL(github.tokenGuide('https://ghe.example.com/api/v3/').url);
  assert.equal(enterprise.origin, 'https://ghe.example.com');
  const lab = new URL(gitlab.tokenGuide('https://gitlab.example.com/api/v4/').url);
  assert.equal(lab.pathname, '/-/user_settings/personal_access_tokens');
  assert.equal(lab.searchParams.get('scopes'), 'api,write_repository');
  assert.equal(gitea.tokenGuide('http://gitea:3000/api/v1/').url, 'http://gitea:3000/user/settings/applications');
});

test('GitHub: the account is read and missing classic scopes are reported', async () => {
  const fetcher = fakeFetch({
    'GET /user': { body: { id: 7, login: 'octo', name: null, avatar_url: 'https://a/1.png' }, headers: { 'x-oauth-scopes': 'repo' } },
  });
  const me = await github.whoami({ endpoint: 'https://api.github.com/', token: 't', fetch: fetcher });
  assert.deepEqual({ login: me.login, name: me.name, id: me.id }, { login: 'octo', name: 'octo', id: '7' });
  assert.deepEqual(me.warnings, [{ code: 'missing_scope', scope: 'workflow' }]);
  assert.equal(fetcher.calls[0].headers.Authorization, 'Bearer t');
});

test('GitHub: repositories are collected across pages', async () => {
  const repo = (name, extra = {}) => ({ full_name: name, html_url: `https://github.com/${name}`, default_branch: 'main', private: false, fork: false, archived: false, permissions: { push: true }, ...extra });
  const fetcher = fakeFetch({
    'GET /user/repos?per_page=100': (url) => (url.includes('page=2')
      ? { body: [repo('a/three', { archived: true })] }
      : { body: [repo('a/one'), repo('a/two', { permissions: { push: false } })], headers: { link: '<https://api.github.com/user/repos?per_page=100&page=2>; rel="next"' } }),
  });
  const all = [];
  for await (const item of github.listRepositories({ endpoint: 'https://api.github.com/', token: 't', fetch: fetcher })) all.push(item);
  assert.deepEqual(all.map((item) => [item.fullName, item.canPush, item.isArchived]), [['a/one', true, false], ['a/two', false, false], ['a/three', true, true]]);
});

test('Gitea: an account without full name or email is flagged', async () => {
  const profile = (body) => gitea.whoami({ endpoint: 'http://g/api/v1/', token: 't', fetch: fakeFetch({ 'GET /user': { body } }) });
  assert.deepEqual((await profile({ id: 1, login: 'a' })).warnings, [{ code: 'missing_profile' }]);
  assert.deepEqual((await profile({ id: 1, login: 'a', full_name: 'A B', email: 'a@example.com' })).warnings, []);
});

test('GitLab: pagination follows x-next-page and forks are flagged', async () => {
  const fetcher = fakeFetch({
    'GET /projects': (url) => (url.includes('page=2')
      ? { body: [{ path_with_namespace: 'g/b', visibility: 'public', forked_from_project: { id: 1 } }] }
      : { body: [{ path_with_namespace: 'g/a', visibility: 'private' }], headers: { 'x-next-page': '2' } }),
  });
  const all = [];
  for await (const item of gitlab.listRepositories({ endpoint: 'https://gitlab.com/api/v4/', token: 't', fetch: fetcher })) all.push(item);
  assert.deepEqual(all.map((item) => [item.fullName, item.isPrivate, item.isFork]), [['g/a', true, false], ['g/b', false, true]]);
  assert.equal(fetcher.calls[0].headers['PRIVATE-TOKEN'], 't');
});

test('Gitea: mirrors and repositories without pull requests are not offered', async () => {
  const fetcher = fakeFetch({ 'GET /user/repos': { body: [
    { full_name: 'a/ok', permissions: { push: true } },
    { full_name: 'a/mirror', permissions: { push: true }, mirror: true },
    { full_name: 'a/no-prs', permissions: { push: true }, has_pull_requests: false },
  ] } });
  const all = [];
  for await (const item of gitea.listRepositories({ endpoint: 'http://g/api/v1/', token: 't', fetch: fetcher })) all.push([item.fullName, item.canPush]);
  assert.deepEqual(all, [['a/ok', true], ['a/mirror', false], ['a/no-prs', false]]);
});

test('Gitea: a token is created from the password, with the scopes Renovate needs', async () => {
  const fetcher = fakeFetch({ 'POST /users/sven/tokens': { status: 201, body: { id: 3, sha1: 'secret-token' } } });
  const { token, tokenName } = await gitea.credentialLogin.createToken({ endpoint: 'http://g:3000/api/v1/', fetch: fetcher }, { username: 'sven', password: 'pw', otp: '123456' });
  assert.equal(token, 'secret-token');
  assert.match(tokenName, /^renovate-home-assistant-[a-f0-9]{6}$/);
  const [call] = fetcher.calls;
  assert.equal(call.headers.Authorization, `Basic ${Buffer.from('sven:pw').toString('base64')}`);
  assert.equal(call.headers['X-GITEA-OTP'], '123456');
  assert.deepEqual(JSON.parse(call.body).scopes, ['write:repository', 'write:issue', 'read:user', 'read:organization', 'read:misc']);
});

test('Gitea: wrong passwords and missing one-time codes are told apart', async () => {
  const wrong = fakeFetch({ 'POST /tokens': { status: 401, body: { message: 'invalid username or password' } } });
  await assert.rejects(gitea.credentialLogin.createToken({ endpoint: 'http://g/api/v1/', fetch: wrong }, { username: 'a', password: 'b' }), { code: 'provider_bad_credentials' });
  const otp = fakeFetch({ 'POST /tokens': { status: 401, body: { message: 'a two-factor code is required' } } });
  await assert.rejects(gitea.credentialLogin.createToken({ endpoint: 'http://g/api/v1/', fetch: otp }, { username: 'a', password: 'b' }), { code: 'provider_otp_required' });
});

test('errors name the problem and what to do about it', async () => {
  const tls = Object.assign(new TypeError('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } });
  await assert.rejects(requestJson('https://g.example/api', { fetch: fakeFetch({ 'GET /api': tls }) }), { code: 'provider_tls' });
  const down = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  await assert.rejects(requestJson('https://g.example/api', { fetch: fakeFetch({ 'GET /api': down }) }), { code: 'provider_unreachable' });
  await assert.rejects(requestJson('https://g.example/api', { fetch: fakeFetch({ 'GET /api': { status: 401 } }) }), { code: 'provider_unauthorized' });
  await assert.rejects(requestJson('https://g.example/api', { fetch: fakeFetch({ 'GET /api': { status: 403 } }) }), { code: 'provider_forbidden' });
  await assert.rejects(requestJson('https://g.example/api', { fetch: fakeFetch({ 'GET /api': { status: 500 } }) }), { code: 'provider_error' });
});

test('GitHub device flow: code, polling states and the granted token', async () => {
  let answer = { error: 'authorization_pending' };
  const fetcher = fakeFetch({
    'POST /login/device/code': { body: { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900 } },
    'POST /login/oauth/access_token': () => ({ body: answer }),
  });
  const ctx = { endpoint: 'https://api.github.com/', fetch: fetcher };
  const started = await github.deviceFlow.start(ctx, 'client');
  assert.equal(started.userCode, 'ABCD-1234');
  assert.equal(started.interval, 5);
  assert.equal((await github.deviceFlow.poll(ctx, 'client', 'dc')).status, 'pending');
  answer = { error: 'slow_down' };
  assert.equal((await github.deviceFlow.poll(ctx, 'client', 'dc')).status, 'slow_down');
  answer = { access_token: 'gho_x' };
  assert.deepEqual(await github.deviceFlow.poll(ctx, 'client', 'dc'), { status: 'granted', token: 'gho_x' });
});

test('webhook signatures are verified per provider', () => {
  const body = Buffer.from('{"a":1}');
  const secret = 's3cret';
  const hex = hmacSha256Hex(secret, body);
  assert.ok(github.webhooks.verify({ 'x-hub-signature-256': `sha256=${hex}` }, body, secret));
  assert.ok(!github.webhooks.verify({ 'x-hub-signature-256': 'sha256=00' }, body, secret));
  assert.ok(!github.webhooks.verify({}, body, secret));
  assert.ok(gitea.webhooks.verify({ 'x-gitea-signature': hex }, body, secret));
  assert.ok(forgejo.webhooks.verify({ 'x-forgejo-signature': hex }, body, secret));
  assert.ok(gitea.webhooks.verify({ 'x-hub-signature-256': `sha256=${hex}` }, body, secret));
  assert.ok(!gitea.webhooks.verify({ 'x-gitea-signature': 'bad' }, body, secret));
  assert.ok(gitlab.webhooks.verify({ 'x-gitlab-token': secret }, body, secret));
  assert.ok(!gitlab.webhooks.verify({ 'x-gitlab-token': 'nope' }, body, secret));
});

test('webhook deliveries are reduced to the events that matter', () => {
  const repository = { full_name: 'o/r', default_branch: 'main' };
  const sender = { login: 'sven' };
  const hub = (event, payload) => github.webhooks.parse({ 'x-github-event': event }, { repository, sender, ...payload });
  assert.equal(hub('push', { ref: 'refs/heads/main' }).kind, 'push-default');
  assert.equal(hub('push', { ref: 'refs/heads/renovate/x' }).kind, 'ignored');
  assert.equal(hub('pull_request', { action: 'closed' }).kind, 'pull-request-closed');
  assert.equal(hub('pull_request', { action: 'opened' }).kind, 'ignored');
  assert.equal(hub('issues', { action: 'edited', issue: { title: 'Dependency Dashboard' } }).kind, 'issue-edited');
  assert.equal(hub('ping', {}).kind, 'ping');
  assert.equal(hub('ping', {}).repository, 'o/r');
  const lab = (event, payload) => gitlab.webhooks.parse({ 'x-gitlab-event': event }, { project: { path_with_namespace: 'g/p', default_branch: 'main' }, user_username: 'bot', ...payload });
  assert.equal(lab('Push Hook', { ref: 'refs/heads/main' }).kind, 'push-default');
  assert.equal(lab('Merge Request Hook', { object_attributes: { action: 'merge' } }).kind, 'pull-request-closed');
  assert.equal(lab('Issue Hook', { object_attributes: { action: 'update' }, changes: { description: {} } }).kind, 'issue-edited');
  assert.equal(lab('Issue Hook', { object_attributes: { action: 'update' }, changes: {} }).kind, 'ignored');
  assert.equal(lab('Push Hook', { ref: 'refs/heads/main' }).sender, 'bot');
  const tea = (event, payload) => gitea.webhooks.parse({ 'x-gitea-event': event }, { repository, sender: { login: 'x' }, ...payload });
  assert.equal(tea('pull_request', { action: 'closed' }).kind, 'pull-request-closed');
});

test('webhooks are created once and updated afterwards', async () => {
  const created = fakeFetch({ 'GET /hooks': { body: [] }, 'POST /hooks': { status: 201, body: {} } });
  assert.equal(await github.webhooks.register({ endpoint: 'https://api.github.com/', token: 't', fetch: created }, 'o/r', { url: 'https://x/hooks/1', secret: 's', events: ['push'] }), 'created');
  const updated = fakeFetch({ 'GET /hooks': { body: [{ id: 9, config: { url: 'https://x/hooks/1' } }] }, 'PATCH /hooks/9': { body: {} } });
  assert.equal(await github.webhooks.register({ endpoint: 'https://api.github.com/', token: 't', fetch: updated }, 'o/r', { url: 'https://x/hooks/1', secret: 's', events: ['push'] }), 'updated');
});

test('the browser learns which sign-in methods exist', () => {
  const byId = Object.fromEntries(describeProviders({ githubClientId: 'abc' }).map((entry) => [entry.id, entry]));
  assert.equal(byId.github.deviceFlow, true);
  assert.equal(byId.gitea.credentialLogin, true);
  assert.equal(byId.gitlab.deviceFlow, false);
  assert.equal(describeProviders({}).find((entry) => entry.id === 'github').deviceFlow, false);
  assert.throws(() => getProvider('nope'), /Unknown git server/);
});
