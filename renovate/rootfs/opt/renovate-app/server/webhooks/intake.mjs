// Receives deliveries from the git servers, checks their signature, decides whether they matter and turns the
// relevant ones into one debounced run per connection. Everything else is acknowledged and ignored.
import { getProvider } from '../providers/index.mjs';
import { AppError } from '../util/errors.mjs';
import { log } from '../util/log.mjs';

const DASHBOARD_TITLE = /dependency dashboard/i;
const reply = (status, body) => ({ status, body });

export function createWebhookIntake({ connections, queue, settings, timers = { setTimeout, clearTimeout } }) {
  /** connection id → { repositories: Set<string>, timer } */
  const pending = new Map();

  function schedule(connectionId, repository) {
    let entry = pending.get(connectionId);
    if (!entry) {
      entry = { repositories: new Set(), timer: null };
      entry.timer = timers.setTimeout(() => {
        pending.delete(connectionId);
        try {
          queue.enqueue({ connectionId, repositories: [...entry.repositories], trigger: 'webhook' });
        } catch (error) {
          log.warn('A webhook could not be turned into a run', error);
        }
      }, settings.get('webhooks.debounce_seconds') * 1000);
      entry.timer.unref?.();
      pending.set(connectionId, entry);
    }
    entry.repositories.add(repository);
  }

  return {
    /**
     * @param {{connectionId:string, headers:Record<string,string|string[]|undefined>, rawBody:Buffer}} delivery
     * @returns {{status:number, body:object}}
     */
    handle({ connectionId, headers, rawBody }) {
      if (!settings.get('webhooks.enabled')) return reply(404, { error: 'webhooks_disabled' });
      let connection;
      try {
        connection = connections.getForRun(connectionId);
      } catch (error) {
        if (error instanceof AppError && error.status === 404) return reply(404, { error: 'unknown_connection' });
        throw error;
      }
      const provider = getProvider(connection.provider);
      if (!provider.webhooks.verify(headers, rawBody, connection.webhookSecret)) return reply(401, { error: 'bad_signature' });

      let payload;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return reply(400, { error: 'invalid_json' });
      }
      const event = provider.webhooks.parse(headers, payload);
      if (event.kind === 'ping') return reply(200, { ok: true, pong: true });
      if (event.kind === 'ignored') return reply(202, { ignored: 'event' });
      if (event.kind === 'issue-edited' && !DASHBOARD_TITLE.test(event.title ?? '')) return reply(202, { ignored: 'issue' });
      if (settings.get('webhooks.ignore_own_events') && event.sender && event.sender === connection.accountLogin) {
        return reply(202, { ignored: 'own-event' });
      }
      const known = connections.enabledRepositoryNames(connectionId).find((name) => name.toLowerCase() === String(event.repository).toLowerCase());
      if (!known) return reply(202, { ignored: 'repository' });
      schedule(connectionId, known);
      return reply(202, { queued: true, repository: known });
    },

    /** Drops everything that is still waiting; used on shutdown and in tests. */
    cancelPending() {
      for (const entry of pending.values()) timers.clearTimeout(entry.timer);
      pending.clear();
    },
  };
}
