// The JSON API of the web interface. Handlers stay thin: they check input, call a service and return data.
import { rmSync, mkdirSync } from 'node:fs';
import { GITEA_APP_CANDIDATES, describeProviders, getProvider } from '../providers/index.mjs';
import { DEFAULT_CLIENT_ID } from '../providers/github.mjs';
import { GROUPS } from '../settings/registry.mjs';
import { requestJson } from '../providers/http.mjs';
import { REDIRECT_URI, beginBrowserLogin, finishBrowserLogin } from '../providers/oauth.mjs';
import { badRequest, conflict } from '../util/errors.mjs';
import { HANDLED } from './router.mjs';

const RENOVATE_RELEASES = 'https://github.com/renovatebot/renovate/releases/tag';
const MAX_REPOSITORY_PREVIEW = 5000;
const AVATAR_LIMIT_BYTES = 512 * 1024;

const integer = (value, fallback, { min = 1, max = 1000 } = {}) => {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

export function registerApi(router, app) {
  const { settings, connections, queue, logStore, logBus, scheduler, credentials, flows, paths, info } = app;
  const githubClientId = () => settings.get('advanced.github_client_id') || DEFAULT_CLIENT_ID;
  const get = (path, handler) => router.add('GET', path, handler);
  const post = (path, handler) => router.add('POST', path, handler);

  get('/api/health', () => ({ ok: true }));

  get('/api/boot', () => ({
    version: info.version,
    renovate: { version: info.renovateVersion, url: `${RENOVATE_RELEASES}/${info.renovateVersion}` },
    general: {
      language: settings.get('general.language'),
      theme: settings.get('general.theme'),
      accent: settings.get('general.accent'),
      accentColor: settings.get('general.accent_color'),
    },
    providers: describeProviders({ githubClientId: githubClientId() }),
    homeAssistant: app.ha.available,
  }));

  get('/api/status', () => {
    const running = queue.status();
    return {
      running: running.running.map((id) => queue.get(id)),
      queued: running.queued,
      nextRunAt: scheduler.nextRunAt() ? new Date(scheduler.nextRunAt()).toISOString() : null,
      schedule: { mode: settings.get('schedule.mode'), cron: settings.get('schedule.cron'), intervalMinutes: settings.get('schedule.interval_minutes') },
      resources: app.getResources(),
      machine: app.machine,
      webhooks: app.webhookServer.status(),
      configuration: app.configuration,
    };
  });

  // --- connecting a git server ---------------------------------------------------------------------
  const describeCandidate = async (provider, endpoint, token, extra = {}) => {
    const checked = await connections.verify({ provider, endpoint, token, username: extra.username });
    const found = [];
    // Counting what the token can reach tells the user at once whether the permissions are right.
    for await (const repository of getProvider(provider).listRepositories({ endpoint: checked.endpoint, token, username: checked.username, fetch: app.fetch })) {
      found.push(repository);
      if (found.length >= MAX_REPOSITORY_PREVIEW) break;
    }
    const credentialId = credentials.put({ provider, endpoint: checked.endpoint, token, ...extra, username: checked.username });
    return {
      credentialId,
      endpoint: checked.endpoint,
      account: { login: checked.account.login, name: checked.account.name },
      warnings: checked.account.warnings,
      repositoryCount: found.length,
      pushableCount: found.filter((repository) => repository.canPush).length,
    };
  };

  get('/api/connect/guide', ({ query }) => {
    const provider = getProvider(query.get('provider'));
    const endpoint = provider.normalizeEndpoint(query.get('endpoint') ?? '');
    return { endpoint, ...provider.tokenGuide(endpoint) };
  });

  post('/api/connect/verify', async ({ body }) => describeCandidate(body.provider, body.endpoint, String(body.token ?? '').trim(), { username: body.username }));

  post('/api/connect/gitea', async ({ body }) => {
    const provider = getProvider(body.provider);
    if (!provider.credentialLogin) throw badRequest('unsupported', 'This server type has no sign-in with a password');
    const endpoint = provider.normalizeEndpoint(body.endpoint);
    const { token, tokenName } = await provider.credentialLogin.createToken({ endpoint, fetch: app.fetch }, { username: String(body.username ?? '').trim(), password: String(body.password ?? ''), otp: body.otp ? String(body.otp).trim() : undefined });
    return describeCandidate(body.provider, endpoint, token, { tokenName });
  });

  post('/api/connect/device/start', async ({ body }) => {
    const provider = getProvider(body.provider);
    if (!provider.deviceFlow || !githubClientId()) throw badRequest('unsupported', 'Signing in with a code is not available for this server');
    const endpoint = provider.normalizeEndpoint(body.endpoint ?? '');
    const started = await provider.deviceFlow.start({ endpoint, fetch: app.fetch }, githubClientId());
    const flowId = flows.put({ provider: body.provider, endpoint, deviceCode: started.deviceCode });
    return { flowId, userCode: started.userCode, verificationUri: started.verificationUri, expiresIn: started.expiresIn, interval: started.interval };
  });

  post('/api/connect/device/poll', async ({ body }) => {
    const flow = flows.peek(body.flowId);
    const provider = getProvider(flow.provider);
    const result = await provider.deviceFlow.poll({ endpoint: flow.endpoint, fetch: app.fetch }, githubClientId(), flow.deviceCode);
    if (result.status !== 'granted') {
      if (['expired', 'denied'].includes(result.status)) flows.take(body.flowId);
      return { status: result.status };
    }
    flows.take(body.flowId);
    return { status: 'granted', ...(await describeCandidate(flow.provider, flow.endpoint, result.token)) };
  });

  // Sign-in through the browser: the user registers the app once on the server, signs in there (password, passkey,
  // security key, single sign-on) and pastes the address the browser ended on.
  get('/api/connect/browser-guide', ({ query }) => {
    const provider = getProvider(query.get('provider'));
    if (!provider.browserLogin) throw badRequest('unsupported', 'This server type has no sign-in through the browser');
    const endpoint = provider.normalizeEndpoint(query.get('endpoint') ?? '');
    return { redirectUri: REDIRECT_URI, appsUrl: `${provider.webUrl(endpoint)}${provider.browserLogin.applicationsPath}`, scope: provider.browserLogin.scope };
  });

  post('/api/connect/browser/start', ({ body }) => {
    const provider = getProvider(body.provider);
    const clientId = String(body.clientId ?? '').trim();
    if (!clientId) throw badRequest('client_id_required', 'The client ID of the application is required');
    const endpoint = provider.normalizeEndpoint(body.endpoint ?? '');
    const started = beginBrowserLogin(provider, { endpoint, clientId });
    const flowId = flows.put({ provider: body.provider, endpoint, clientId, state: started.state, verifier: started.verifier });
    return { flowId, authorizeUrl: started.authorizeUrl };
  });

  post('/api/connect/browser/finish', async ({ body }) => {
    const flow = flows.peek(body.flowId);
    const provider = getProvider(flow.provider);
    const tokens = await finishBrowserLogin(provider, { endpoint: flow.endpoint, fetch: app.fetch }, { clientId: flow.clientId, verifier: flow.verifier, state: flow.state, pasted: body.pasted });
    flows.take(body.flowId);
    return describeCandidate(flow.provider, flow.endpoint, tokens.accessToken, { oauth: { clientId: flow.clientId, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt } });
  });

  post('/api/connect/discover', async () => {
    const found = [];
    await Promise.all(GITEA_APP_CANDIDATES.map(async (url) => {
      try {
        const { data } = await requestJson(`${url}/api/v1/version`, { timeout: 1500, fetch: app.fetch });
        if (data?.version) found.push({ url, version: data.version });
      } catch {
        // Not there: the candidate is simply not offered.
      }
    }));
    return { found };
  });

  // --- connections -----------------------------------------------------------------------------------
  get('/api/connections', () => connections.list());
  post('/api/connections', async ({ body }) => {
    const credential = body.credentialId ? credentials.take(body.credentialId) : null;
    const source = credential ?? { provider: body.provider, endpoint: body.endpoint, token: body.token, username: body.username };
    const { connection, warnings } = await connections.create({ name: body.name, provider: source.provider, endpoint: source.endpoint, token: source.token, username: source.username ?? null, oauth: credential?.oauth ?? null, tokenName: credential?.tokenName ?? null, mode: body.mode ?? 'selected' });
    const patch = {};
    for (const key of ['includePatterns', 'excludePatterns', 'skipForks', 'skipArchived']) if (key in body) patch[key] = body[key];
    if (Object.keys(patch).length) connections.update(connection.id, patch);
    for (const name of body.selected ?? []) {
      const repository = connections.repositories(connection.id).find((entry) => entry.fullName === name);
      if (repository) connections.setRepositoryOverride(connection.id, repository.id, 1);
    }
    app.publisher.refresh();
    return { connection: connections.get(connection.id), warnings };
  });
  get('/api/connections/:id', ({ params }) => connections.get(params.id));
  router.add('PATCH', '/api/connections/:id', ({ params, body }) => connections.update(params.id, body));
  router.add('DELETE', '/api/connections/:id', ({ params }) => {
    connections.remove(params.id);
    app.publisher.refresh();
  });
  router.add('PUT', '/api/connections/:id/token', async ({ params, body }) => connections.replaceToken(params.id, String(body.token ?? '').trim()));
  post('/api/connections/:id/sync', async ({ params }) => ({ count: await connections.syncRepositories(params.id) }));
  get('/api/connections/:id/repositories', ({ params }) => connections.repositories(params.id));
  router.add('PATCH', '/api/connections/:id/repositories/:repositoryId', ({ params, body }) => {
    connections.setRepositoryOverride(params.id, Number(params.repositoryId), body.override ?? null);
  });
  post('/api/connections/:id/repositories/bulk', ({ params, body }) => {
    if (body.names !== null && !Array.isArray(body.names)) throw badRequest('invalid_names', 'names must be a list or null');
    connections.setBulkOverride(params.id, body.names ?? null, body.override ?? null);
  });

  get('/api/connections/:id/webhook', ({ params }) => {
    const publicUrl = settings.get('webhooks.public_url');
    if (!getProvider(connections.get(params.id).provider).webhooks) return { supported: false };
    return {
      supported: true,
      enabled: settings.get('webhooks.enabled'),
      url: publicUrl ? `${publicUrl}/hooks/${params.id}` : null,
      secret: connections.getWebhookSecret(params.id),
      port: settings.get('webhooks.port'),
      events: getProvider(connections.get(params.id).provider).webhookEvents,
    };
  });
  post('/api/connections/:id/webhook/register', async ({ params }) => {
    const publicUrl = settings.get('webhooks.public_url');
    if (!settings.get('webhooks.enabled') || !publicUrl) throw conflict('webhooks_not_ready', 'Switch on webhooks and enter the public address first');
    return connections.registerWebhooks(params.id, { url: `${publicUrl}/hooks/${params.id}` });
  });

  const avatars = new Map();
  get('/api/connections/:id/avatar', async ({ params, res }) => {
    const url = connections.avatarUrl(params.id);
    if (!url) throw badRequest('no_avatar', 'No picture');
    let cached = avatars.get(url);
    if (!cached) {
      // Fetched by the app, not the browser: internal addresses such as http://xxxx-gitea:3000 are not reachable from it.
      const response = await app.fetch(url, { signal: AbortSignal.timeout(5000) });
      const type = response.headers.get('content-type') ?? '';
      const data = Buffer.from(await response.arrayBuffer());
      if (!response.ok || !/^image\/(png|jpeg|gif|webp)/.test(type) || data.length > AVATAR_LIMIT_BYTES) throw badRequest('no_avatar', 'No picture');
      cached = { type, data };
      if (avatars.size > 20) avatars.delete(avatars.keys().next().value);
      avatars.set(url, cached);
    }
    res.writeHead(200, { 'Content-Type': cached.type, 'Cache-Control': 'private, max-age=3600', 'Content-Length': cached.data.length, 'X-Content-Type-Options': 'nosniff' });
    res.end(cached.data);
    return HANDLED;
  });

  // --- runs --------------------------------------------------------------------------------------------
  get('/api/runs', ({ query }) => queue.list({ limit: integer(query.get('limit'), 50, { max: 200 }), connectionId: query.get('connection') }));
  get('/api/runs/:id', ({ params }) => queue.get(Number(params.id)));
  get('/api/runs/:id/log', ({ params, query }) => {
    queue.get(Number(params.id));
    return logStore.read(Number(params.id), { offset: integer(query.get('offset'), 0, { min: 0, max: Number.MAX_SAFE_INTEGER }), limit: integer(query.get('limit'), 500, { max: 2000 }), level: query.get('level') ?? 'trace' });
  });
  post('/api/runs', ({ body }) => {
    if (body.connectionId) return queue.enqueue({ connectionId: body.connectionId, repositories: body.repositories ?? null, trigger: 'manual', dryRun: body.dryRun ?? null });
    const runs = queue.enqueueAll('manual', body.dryRun ?? null);
    if (runs.length === 0) throw conflict('nothing_to_run', 'No connection has repositories switched on');
    return { runs };
  });
  post('/api/runs/:id/cancel', ({ params }) => queue.cancel(Number(params.id)));

  /** Live log: Server-Sent Events. The client first loads the stored part and passes its end as `from`. */
  get('/api/runs/:id/stream', ({ req, res, params, query }) => {
    const runId = Number(params.id);
    queue.get(runId);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let sentUpTo = integer(query.get('from'), 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
    const onLog = (id, entry, endOffset) => {
      if (id !== runId || endOffset <= sentUpTo) return;
      sentUpTo = endOffset;
      send('log', entry);
    };
    const onRun = (run) => {
      if (run.id !== runId) return;
      send('run', { status: run.status });
      if (!['queued', 'running'].includes(run.status)) {
        cleanup();
        res.end();
      }
    };
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      logBus.off('log', onLog);
      queue.events.off('run', onRun);
    };
    logBus.on('log', onLog);
    queue.events.on('run', onRun);
    req.on('close', cleanup);
    // Catch up with whatever was written between the client's read and this subscription.
    const backlog = logStore.read(runId, { offset: sentUpTo, limit: 2000 });
    for (const entry of backlog.entries) send('log', entry);
    sentUpTo = Math.max(sentUpTo, backlog.nextOffset);
    const current = queue.get(runId);
    send('run', { status: current.status });
    if (!['queued', 'running'].includes(current.status)) {
      cleanup();
      res.end();
    }
    return HANDLED;
  });

  // --- settings and maintenance --------------------------------------------------------------------------
  get('/api/settings', () => ({ groups: GROUPS, settings: settings.describe(), resources: app.getResources(), machine: app.machine }));
  router.add('PUT', '/api/settings', ({ body }) => {
    settings.update(body.changes ?? {});
    return { groups: GROUPS, settings: settings.describe(), resources: app.getResources() };
  });

  post('/api/configuration/reload', async () => ({ ...(await app.reloadConfiguration()), configuration: app.configuration }));

  post('/api/maintenance/clear-cache', () => {
    // The folder is fixed by the app, never taken from the request.
    rmSync(paths.cache, { recursive: true, force: true });
    mkdirSync(paths.cache, { recursive: true, mode: 0o700 });
  });
  post('/api/maintenance/prune', () => ({ removed: queue.prune({ keepRuns: settings.get('history.keep_runs'), keepDays: settings.get('history.keep_log_days') }) }));
}
