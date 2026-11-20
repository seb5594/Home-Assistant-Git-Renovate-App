// A complete in-memory application core for tests: database, settings, connections, queue and a runner
// that starts the fake Renovate script instead of the real one.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, memoryDatabase, tempDir, testVault } from './helpers.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** A fetch double: routes are "METHOD fragment" → { status, body, headers } or a function. */
export function fakeFetch(routes) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url: String(url), method, headers: init.headers, body: init.body });
    for (const [key, reply] of Object.entries(routes)) {
      const [routeMethod, fragment] = key.split(' ');
      if (routeMethod === method && String(url).includes(fragment)) {
        const value = typeof reply === 'function' ? reply(String(url), init) : reply;
        return new Response(value.body === undefined ? '' : JSON.stringify(value.body), { status: value.status ?? 200, headers: value.headers ?? {} });
      }
    }
    return new Response('{"message":"no route"}', { status: 404 });
  };
  fetcher.calls = calls;
  return fetcher;
}

export const giteaRoutes = (names = ['sven/one', 'sven/two', 'sven/three']) => ({
  'GET /user/repos': { body: names.map((full_name) => ({ full_name, html_url: `http://g/${full_name}`, default_branch: 'main', private: true, fork: false, archived: false, permissions: { push: true } })) },
  'GET /user': { body: { id: 1, login: 'sven', full_name: 'Sven', avatar_url: 'http://g/a.png' } },
});

export async function createEnvironment(t, { options = {}, routes = giteaRoutes(), resources = {} } = {}) {
  const { createSettings } = await load('settings/store.mjs');
  const { createConnections } = await load('domain/connections.mjs');
  const { createLogStore } = await load('runs/log-store.mjs');
  const { createRunner } = await load('runs/runner.mjs');
  const { createRunQueue } = await load('runs/queue.mjs');

  const dir = tempDir(t);
  const db = await memoryDatabase();
  const vault = await testVault();
  const settings = createSettings({ db, vault, options });
  const fetcher = fakeFetch(routes);
  const connections = createConnections({ db, vault, fetch: fetcher });
  const logStore = createLogStore({ dir: path.join(dir, 'runs') });
  const limits = { profile: 'balanced', automatic: false, maxConcurrentRuns: 1, memoryLimitMb: 512, batchSize: 10, cpuPriority: 10, timeoutMs: 60_000, ...resources };
  const paths = { work: path.join(dir, 'work'), cache: path.join(dir, 'cache'), userConfig: path.join(dir, 'config'), renovateBin: path.join(fixtures, 'fake-renovate.mjs') };
  const runner = createRunner({ settings, connections, logStore, getResources: () => limits, paths, processEnv: process.env, renovateVersion: () => '0.0.0-test' });
  const queue = createRunQueue({ db, runner, connections, getResources: () => limits, logStore });

  /** Resolves when the run has finished, whatever the outcome. */
  const finished = (runId) => new Promise((resolve) => {
    const check = (run) => {
      if (run.id === runId && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
        queue.events.off('run', check);
        resolve(run);
      }
    };
    queue.events.on('run', check);
    const now = queue.get(runId);
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(now.status)) check(now);
  });

  const connect = async (extra = {}) => (await connections.create({ name: 'Home Gitea', provider: 'gitea', endpoint: 'http://g:3000', token: 'tok', mode: 'all', ...extra })).connection;

  return { dir, db, vault, settings, connections, logStore, queue, runner, limits, paths, fetcher, finished, connect };
}
