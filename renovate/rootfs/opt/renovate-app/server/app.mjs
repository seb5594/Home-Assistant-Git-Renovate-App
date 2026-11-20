// Wires the application together. Nothing is global: every part receives what it needs, which is what lets
// the tests run the complete app with a fake git server and a fake Renovate.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { openDatabase } from './db/database.mjs';
import { reconcileManagedConnections, specsFromOptions } from './domain/managed.mjs';
import { createConnections } from './domain/connections.mjs';
import { createPendingStore } from './domain/pending.mjs';
import { createHomeAssistant } from './ha/client.mjs';
import { createPublisher } from './ha/publisher.mjs';
import { registerApi } from './http/api.mjs';
import { INGRESS_ADDRESSES, createRequestHandler, createRouter } from './http/router.mjs';
import { createStaticServer } from './http/static.mjs';
import { createLogStore } from './runs/log-store.mjs';
import { createRunQueue } from './runs/queue.mjs';
import { detectMachine, resolveResources } from './runs/resources.mjs';
import { createRunner } from './runs/runner.mjs';
import { createScheduler } from './scheduling/scheduler.mjs';
import { createVault, loadOrCreateKey } from './security/crypto.mjs';
import { createSettings } from './settings/store.mjs';
import { log, setLogLevel } from './util/log.mjs';
import { createWebhookIntake } from './webhooks/intake.mjs';
import { createWebhookServer } from './webhooks/server.mjs';

const MAINTENANCE_INTERVAL_MS = 6 * 3600_000;

function readText(file, fallback) {
  try {
    return readFileSync(file, 'utf8').trim() || fallback;
  } catch {
    return fallback;
  }
}

function readOptions(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * @param {object} config
 * @param {typeof import('./paths.mjs').paths} config.paths
 * @param {object} [config.options] contents of options.json; read from disk when omitted
 * @param {string|null} [config.databaseFile] ':memory:' for tests
 * @param {number} [config.port] port of the web interface
 * @param {string[]|null} [config.allowedAddresses] null disables the source check
 */
export async function createApp({ paths, options = readOptions(paths.options), databaseFile = paths.database, port = 8099, allowedAddresses = INGRESS_ADDRESSES, fetch: fetcher = fetch, ha = createHomeAssistant({ fetch: fetcher }), processEnv = process.env, versionFile = '/etc/renovate-app/version' }) {
  const db = openDatabase(databaseFile, paths.migrations);
  const vault = createVault(loadOrCreateKey(paths.keyFile));
  const settings = createSettings({ db, vault, options });
  setLogLevel(settings.get('general.log_level'));

  const machine = detectMachine(os);
  const getResources = () => resolveResources(settings.values(), machine);
  const info = {
    version: readText(versionFile, 'dev'),
    renovateVersion: (() => {
      try {
        return JSON.parse(readFileSync(paths.renovatePackage, 'utf8')).version;
      } catch {
        return 'unknown';
      }
    })(),
  };

  const logBus = new EventEmitter();
  const logStore = createLogStore({ dir: paths.runs, emit: (runId, entry, endOffset) => logBus.emit('log', runId, entry, endOffset) });
  const connections = createConnections({ db, vault, fetch: fetcher });
  const runner = createRunner({ settings, connections, logStore, getResources, paths, processEnv, renovateVersion: () => info.renovateVersion });
  const queue = createRunQueue({ db, runner, connections, getResources, logStore });

  const timeZone = () => settings.get('general.timezone') || processEnv.TZ || 'UTC';
  // Before every automatic run the repository lists are refreshed, so new repositories are picked up.
  async function runScheduled(trigger) {
    for (const connection of connections.list()) {
      if (!connection.enabled) continue;
      await connections.syncRepositories(connection.id).catch((error) => log.warn(`The repositories of "${connection.name}" could not be refreshed`, error));
    }
    queue.enqueueAll(trigger);
  }
  const scheduler = createScheduler({
    getSchedule: () => ({ mode: settings.get('schedule.mode'), cron: settings.get('schedule.cron'), intervalMinutes: settings.get('schedule.interval_minutes'), timeZone: timeZone() }),
    trigger: () => { runScheduled('schedule').catch((error) => log.error('The scheduled run failed to start', error)); },
  });

  const publisher = createPublisher({ ha, queue, connections, settings, nextRunAt: () => scheduler.nextRunAt() });
  const intake = createWebhookIntake({ connections, queue, settings });
  const webhookServer = createWebhookServer({ intake, settings });

  const router = createRouter();
  const app = { settings, connections, queue, logStore, logBus, scheduler, credentials: createPendingStore(), flows: createPendingStore({ ttlMs: 20 * 60_000 }), paths, info, ha, publisher, webhookServer, getResources, machine, fetch: fetcher };
  registerApi(router, app);
  const serveStatic = createStaticServer(paths.ui);
  const server = http.createServer(createRequestHandler({ router, serveStatic, allowedAddresses }));
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;

  settings.onChange((keys) => {
    if (keys.includes('general.log_level')) setLogLevel(settings.get('general.log_level'));
    if (keys.some((key) => key.startsWith('schedule.') || key === 'general.timezone')) scheduler.reschedule();
    if (keys.some((key) => key.startsWith('webhooks.'))) webhookServer.apply();
    if (keys.some((key) => key.startsWith('home_assistant.'))) publisher.refresh();
  });

  let maintenanceTimer = null;
  const maintain = () => queue.prune({ keepRuns: settings.get('history.keep_runs'), keepDays: settings.get('history.keep_log_days') });

  return {
    ...app,
    db,
    server,
    intake,
    async start() {
      await reconcileManagedConnections({ db, vault, connections, specs: specsFromOptions(options) });
      queue.recover();
      maintain();
      maintenanceTimer = setInterval(maintain, MAINTENANCE_INTERVAL_MS);
      maintenanceTimer.unref();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', resolve);
      });
      await webhookServer.apply();
      publisher.start();
      scheduler.reschedule();
      if (settings.get('schedule.run_on_start')) runScheduled('startup').catch((error) => log.error('The start-up run failed to start', error));
      const { port: bound } = server.address();
      log.info(`Renovate app ${info.version} (Renovate ${info.renovateVersion}) is ready on port ${bound} with the ${getResources().profile} resource profile`);
    },
    async stop() {
      clearInterval(maintenanceTimer);
      scheduler.stop();
      publisher.stop();
      intake.cancelPending();
      await queue.stopAll();
      await webhookServer.stop();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}
