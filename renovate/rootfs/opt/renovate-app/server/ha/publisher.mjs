// Shows the state of the app inside Home Assistant: three sensors, an event after every run and, if wanted,
// a notification when a run fails. Updates are collapsed, so a burst of finished runs causes one round of calls.
const DEBOUNCE_MS = 2000;

export function createPublisher({ ha, queue, connections, settings, nextRunAt, timers = { setTimeout, clearTimeout } }) {
  let timer = null;
  let lastFailed = false;

  async function publishSensors() {
    if (!settings.get('home_assistant.sensors')) return;
    const status = queue.status();
    const all = connections.list();
    const openPrs = all.reduce((sum, connection) => sum + (connection.openPrs ?? 0), 0);
    const state = status.running.length ? 'running' : lastFailed ? 'error' : 'idle';
    const next = nextRunAt();
    await Promise.all([
      ha.setState('sensor.renovate_status', state, {
        friendly_name: 'Renovate status',
        icon: 'mdi:package-up',
        queued_runs: status.queued,
        next_run: next ? new Date(next).toISOString() : null,
      }),
      ha.setState('sensor.renovate_open_pull_requests', openPrs, {
        friendly_name: 'Renovate open pull requests',
        icon: 'mdi:source-pull',
        unit_of_measurement: 'PRs',
        state_class: 'measurement',
        by_connection: Object.fromEntries(all.map((connection) => [connection.name, connection.openPrs ?? 0])),
      }),
    ]);
    const [latest] = queue.list({ limit: 20 }).filter((run) => run.finishedAt);
    if (latest) {
      await ha.setState('sensor.renovate_last_run', latest.finishedAt, {
        friendly_name: 'Renovate last run',
        icon: 'mdi:clock-check-outline',
        device_class: 'timestamp',
        result: latest.status,
        connection: latest.connectionName,
      });
    }
  }

  function schedulePublish() {
    if (timer) return;
    timer = timers.setTimeout(() => {
      timer = null;
      publishSensors().catch(() => {});
    }, DEBOUNCE_MS);
    timer.unref?.();
  }

  const onRun = async (run) => {
    schedulePublish();
    if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status)) return;
    lastFailed = run.status === 'failed';
    if (settings.get('home_assistant.events')) {
      await ha.fireEvent('renovate_run_finished', {
        run_id: run.id,
        connection: run.connectionName,
        status: run.status,
        trigger: run.trigger,
        pull_requests_created: run.summary?.totals?.prsCreated ?? 0,
        pull_requests_updated: run.summary?.totals?.prsUpdated ?? 0,
        errors: run.summary?.totals?.errors ?? 0,
      });
    }
    if (run.status === 'failed' && settings.get('home_assistant.failure_notification')) {
      await ha.notify({
        id: `renovate_run_${run.connectionId}`,
        title: 'Renovate run failed',
        message: `The run for "${run.connectionName}" failed (${run.error ?? 'see the log'}). Open the Renovate app for details.`,
      });
    }
  };

  return {
    start() {
      queue.events.on('run', onRun);
      schedulePublish();
    },
    refresh: schedulePublish,
    stop() {
      queue.events.off('run', onRun);
      if (timer) timers.clearTimeout(timer);
      timer = null;
    },
    publishNow: publishSensors,
  };
}
