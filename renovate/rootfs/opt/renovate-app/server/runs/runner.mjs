// Runs Renovate for one queued run: writes its configuration, starts the process in batches, streams the
// log, collects the report and cleans up. Everything the process needs comes from the arguments, so tests can
// substitute a small script for Renovate.
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { getProvider } from '../providers/index.mjs';
import { log } from '../util/log.mjs';
import { buildRenovateConfig, buildRenovateEnv, chunk, runDirectories } from './config-builder.mjs';
import { diagnose } from './diagnose.mjs';
import { toEntry } from './log-store.mjs';
import { summarizeReport, totals } from './report.mjs';

const KILL_GRACE_MS = 10_000;
// With many repositories the per-repository details would make the run record large.
const DETAILED_REPOSITORIES = 30;

/** Stops a process and everything it started (git, npm, ...): the child leads its own process group. */
function terminate(child) {
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
  };
  signalGroup('SIGTERM');
  const timer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}

function readUserConfig(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the file must contain a JSON object');
    return parsed;
  } catch (error) {
    const reason = error.code === 'ENOENT' ? 'the file does not exist' : error.message;
    throw new Error(`The Renovate configuration file ${path.basename(file)} cannot be used: ${reason}`);
  }
}

/**
 * @param {object} deps
 * @param {{values:()=>Record<string,any>}} deps.settings
 * @param {ReturnType<import('../domain/connections.mjs').createConnections>} deps.connections
 * @param {ReturnType<import('./log-store.mjs').createLogStore>} deps.logStore
 * @param {() => ReturnType<import('./resources.mjs').resolveResources>} deps.getResources
 * @param {{work:string, cache:string, userConfig:string, renovateBin:string}} deps.paths
 */
export function createRunner({ settings, connections, logStore, getResources, paths, processEnv = process.env, spawnProcess = spawn, renovateVersion = () => 'unknown' }) {
  /** @returns {Promise<{status:string, exitCode:number|null, error:string|null, summary:object|null, perRepository:Map<string, object>}>} */
  async function execute(run, { signal }) {
    const writer = logStore.open(run.id);
    const note = (level, message) => writer.write({ t: Date.now(), l: level, m: message });
    const values = settings.values();
    const resources = getResources();
    const connection = connections.getForRun(run.connectionId);
    const provider = getProvider(connection.provider);
    const renovate = provider.renovateConnection(connection);
    const directories = runDirectories({ work: paths.work, cache: paths.cache, runId: run.id });
    const perRepository = new Map();
    const collectedEntries = [];
    let exitCode = 0;
    let signalName = null;
    let timedOut = false;
    let cancelled = false;

    try {
      const repositories = run.scope ?? connections.enabledRepositoryNames(run.connectionId);
      if (repositories.length === 0) {
        note('warn', 'No repositories are switched on for this connection, so there is nothing to do.');
        return { status: 'succeeded', exitCode: 0, error: 'no_repositories', summary: { totals: totals(perRepository), repositories: {} }, perRepository };
      }

      mkdirSync(directories.baseDir, { recursive: true, mode: 0o700 });
      mkdirSync(directories.home, { recursive: true, mode: 0o700 });
      mkdirSync(directories.cacheDir, { recursive: true, mode: 0o700 });
      const userConfig = values['renovate.config_file'] ? readUserConfig(path.join(paths.userConfig, values['renovate.config_file'])) : {};

      const batches = chunk(repositories, resources.batchSize);
      note('info', `Renovate ${renovateVersion()} starts for ${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'} of "${connection.name}" `
        + `(${resources.profile} profile, ${resources.memoryLimitMb} MB, ${batches.length} ${batches.length === 1 ? 'batch' : 'batches'}${run.dryRun ? `, preview: ${run.dryRun}` : ''}).`);

      const deadline = Date.now() + resources.timeoutMs;
      for (const [index, batch] of batches.entries()) {
        if (signal.aborted) {
          cancelled = true;
          break;
        }
        if (batches.length > 1) note('info', `Batch ${index + 1} of ${batches.length}: ${batch.length} repositories.`);
        const config = buildRenovateConfig({ connection, renovate, repositories: batch, settings: values, directories, userConfig, dryRun: run.dryRun });
        writeFileSync(directories.configFile, JSON.stringify(config), { mode: 0o600 });
        chmodSync(directories.configFile, 0o600);
        rmSync(directories.reportPath, { force: true });
        const env = buildRenovateEnv({ processEnv, connection, renovate, settings: values, resources, files: { configFile: directories.configFile, home: directories.home } });

        const result = await runBatch({ env, cwd: directories.root, resources, deadline, signal, writer, collectedEntries });
        exitCode = result.exitCode ?? exitCode;
        signalName = result.signal;
        timedOut = result.timedOut;
        cancelled = cancelled || result.cancelled;

        try {
          for (const [name, summary] of summarizeReport(JSON.parse(readFileSync(directories.reportPath, 'utf8')))) perRepository.set(name, summary);
        } catch {
          if (!result.cancelled && !result.timedOut) note('warn', 'Renovate wrote no report for this batch, so the result list may be incomplete.');
        }
        if (result.cancelled || result.timedOut || (result.exitCode !== 0 && result.exitCode !== null)) break;
      }
    } catch (error) {
      note('error', error.message);
      return { status: 'failed', exitCode: null, error: error.message, summary: null, perRepository };
    } finally {
      rmSync(directories.root, { recursive: true, force: true });
      writer.close();
    }

    const diagnosis = diagnose({ entries: collectedEntries, exitCode, signal: signalName, timedOut });
    const crashed = timedOut || signalName !== null || (exitCode !== 0 && exitCode !== null);
    const status = cancelled ? 'cancelled' : crashed ? 'failed' : 'succeeded';
    const detailed = perRepository.size <= DETAILED_REPOSITORIES;
    const repositoriesSummary = Object.fromEntries([...perRepository].map(([name, summary]) => [name, detailed ? summary : { ...summary, branches: [], problems: [] }]));
    return { status, exitCode, error: status === 'failed' ? diagnosis : null, summary: { totals: totals(perRepository), repositories: repositoriesSummary }, perRepository };
  }

  function runBatch({ env, cwd, resources, deadline, signal, writer, collectedEntries }) {
    return new Promise((resolve) => {
      const outcome = { exitCode: null, signal: null, timedOut: false, cancelled: false };
      const child = spawnProcess(process.execPath, [paths.renovateBin], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.on('error', (error) => {
        writer.write({ t: Date.now(), l: 'error', m: `Renovate could not be started: ${error.message}` });
        outcome.exitCode = 127;
        resolve(outcome);
      });
      try {
        if (child.pid) os.setPriority(child.pid, resources.cpuPriority);
      } catch (error) {
        log.debug('Could not lower the priority of Renovate', error);
      }

      const sink = (fallbackLevel) => (line) => {
        const entry = toEntry(line, fallbackLevel);
        if (!entry) return;
        if (entry.l !== 'trace' && entry.l !== 'debug' && collectedEntries.length < 2000) collectedEntries.push(entry);
        writer.write(entry);
      };
      readline.createInterface({ input: child.stdout }).on('line', sink('info'));
      readline.createInterface({ input: child.stderr }).on('line', sink('error'));

      const remaining = Math.max(1000, deadline - Date.now());
      const timer = setTimeout(() => {
        outcome.timedOut = true;
        writer.write({ t: Date.now(), l: 'error', m: 'The run took longer than the configured time limit and is stopped.' });
        terminate(child);
      }, remaining);
      const onAbort = () => {
        outcome.cancelled = true;
        writer.write({ t: Date.now(), l: 'warn', m: 'The run was cancelled.' });
        terminate(child);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });

      child.once('close', (code, killedBy) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        outcome.exitCode = code;
        outcome.signal = killedBy;
        resolve(outcome);
      });
    });
  }

  return { execute };
}
