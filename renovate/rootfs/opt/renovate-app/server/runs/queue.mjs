// The job queue: runs are rows in the database, so a restart loses nothing. At most `maxConcurrentRuns`
// run at once and never two for the same connection (they would fight over the same repositories).
import { EventEmitter } from 'node:events';
import { nowIso, parseJson } from '../db/database.mjs';
import { badRequest, notFound } from '../util/errors.mjs';
import { log } from '../util/log.mjs';

const FINISHED = ['succeeded', 'failed', 'cancelled', 'interrupted'];

export function toRun(row) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    connectionName: row.connection_name,
    trigger: row.trigger,
    scope: parseJson(row.scope, null),
    dryRun: row.dry_run,
    status: row.status,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    summary: parseJson(row.summary, null),
    error: row.error,
  };
}

/** A run as shown in lists: the totals without the per-repository details. */
export function toRunListEntry(row) {
  const run = toRun(row);
  return { ...run, summary: run.summary ? { totals: run.summary.totals } : null };
}

export function createRunQueue({ db, runner, connections, getResources, logStore }) {
  const events = new EventEmitter();
  const running = new Map();

  const selectRun = db.prepare('SELECT * FROM runs WHERE id = ?');
  const publish = (id) => events.emit('run', toRun(selectRun.get(id)));

  function enqueue({ connectionId, repositories = null, trigger, dryRun = null }) {
    const connection = connections.rawRow(connectionId);
    if (!connection.enabled) throw badRequest('connection_disabled', 'This connection is switched off');
    if (dryRun !== null && !['extract', 'lookup', 'full'].includes(dryRun)) throw badRequest('invalid_dry_run', 'The preview mode must be extract, lookup or full');

    // A waiting run for the same connection absorbs the new request: one run does the work of both.
    const waiting = db.prepare("SELECT * FROM runs WHERE status = 'queued' AND connection_id = ? AND COALESCE(dry_run, '') = ? ORDER BY id LIMIT 1")
      .get(connectionId, dryRun ?? '');
    if (waiting) {
      const existing = parseJson(waiting.scope, null);
      const merged = existing === null || repositories === null ? null : [...new Set([...existing, ...repositories])];
      db.prepare('UPDATE runs SET scope = ? WHERE id = ?').run(merged === null ? null : JSON.stringify(merged), waiting.id);
      return { run: toRun(selectRun.get(waiting.id)), merged: true };
    }

    const result = db.prepare(`INSERT INTO runs (connection_id, connection_name, trigger, scope, dry_run, status, queued_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?)`).run(connectionId, connection.name, trigger, repositories === null ? null : JSON.stringify(repositories), dryRun, nowIso());
    const id = Number(result.lastInsertRowid);
    publish(id);
    queueMicrotask(tick);
    return { run: toRun(selectRun.get(id)), merged: false };
  }

  /** Queues a run for every connection that is switched on. */
  function enqueueAll(trigger, dryRun = null) {
    const queued = [];
    for (const connection of connections.list()) {
      if (!connection.enabled || connection.enabledRepositoryCount === 0) continue;
      queued.push(enqueue({ connectionId: connection.id, trigger, dryRun }).run);
    }
    return queued;
  }

  function tick() {
    const limit = getResources().maxConcurrentRuns;
    if (running.size >= limit) return;
    const busy = new Set([...running.values()].map((job) => job.connectionId));
    for (const row of db.prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY id").all()) {
      if (running.size >= limit) break;
      if (busy.has(row.connection_id)) continue;
      busy.add(row.connection_id);
      start(row);
    }
  }

  function start(row) {
    const controller = new AbortController();
    db.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?").run(nowIso(), row.id);
    publish(row.id);
    const job = { connectionId: row.connection_id, controller };
    running.set(row.id, job);
    job.promise = runner.execute(toRun(selectRun.get(row.id)), { signal: controller.signal })
      .then((result) => finish(row, result))
      .catch((error) => {
        log.error(`Run ${row.id} failed unexpectedly`, error);
        return finish(row, { status: 'failed', exitCode: null, error: error.message, summary: null, perRepository: new Map() });
      })
      .finally(() => {
        running.delete(row.id);
        tick();
      });
  }

  function finish(row, result) {
    const finishedAt = nowIso();
    db.prepare('UPDATE runs SET status = ?, finished_at = ?, exit_code = ?, summary = ?, error = ? WHERE id = ?')
      .run(result.status, finishedAt, result.exitCode, result.summary ? JSON.stringify(result.summary) : null, result.error, row.id);
    if (row.connection_id) {
      for (const [name, summary] of result.perRepository) {
        connections.recordRepositoryResult(row.connection_id, name, {
          runId: row.id,
          status: summary.errors > 0 ? 'error' : 'ok',
          openPrs: summary.openPrs,
          at: finishedAt,
        });
      }
    }
    publish(row.id);
  }

  return {
    events,
    enqueue,
    enqueueAll,
    tick,

    cancel(id) {
      const row = selectRun.get(id);
      if (!row) throw notFound('The run');
      if (row.status === 'queued') {
        db.prepare("UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(nowIso(), id);
        publish(id);
      } else if (row.status === 'running') {
        running.get(id)?.controller.abort();
      } else {
        throw badRequest('run_finished', 'This run has already finished');
      }
    },

    /** After a restart, runs that were in progress did not finish; waiting runs simply continue. */
    recover() {
      const interrupted = db.prepare("SELECT id FROM runs WHERE status = 'running'").all();
      for (const { id } of interrupted) {
        db.prepare("UPDATE runs SET status = 'interrupted', finished_at = ?, error = 'interrupted' WHERE id = ?").run(nowIso(), id);
        logStore.append(id, { t: Date.now(), l: 'warn', m: 'The app was restarted while this run was in progress.' });
      }
      tick();
      return interrupted.length;
    },

    get(id) {
      const row = selectRun.get(id);
      if (!row) throw notFound('The run');
      return toRun(row);
    },

    list({ limit = 50, connectionId = null } = {}) {
      const rows = connectionId
        ? db.prepare('SELECT * FROM runs WHERE connection_id = ? ORDER BY id DESC LIMIT ?').all(connectionId, limit)
        : db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit);
      return rows.map(toRunListEntry);
    },

    status() {
      const queued = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'queued'").get().n;
      return { running: [...running.keys()], queued };
    },

    /** Removes old runs and their logs. */
    prune({ keepRuns, keepDays }) {
      const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
      const doomed = db.prepare(`SELECT id FROM runs WHERE status IN (${FINISHED.map(() => '?').join(',')})
        AND (queued_at < ? OR id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT ?))`).all(...FINISHED, cutoff, keepRuns);
      for (const { id } of doomed) {
        db.prepare('DELETE FROM runs WHERE id = ?').run(id);
        logStore.remove(id);
      }
      return doomed.length;
    },

    /** Waits for every running run to end; used when the app shuts down. */
    async stopAll() {
      for (const job of running.values()) job.controller.abort();
      await Promise.allSettled([...running.values()].map((job) => job.promise));
    },
  };
}
