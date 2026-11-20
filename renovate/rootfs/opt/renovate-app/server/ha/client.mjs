// A tiny client for the Home Assistant Core API as the Supervisor proxies it. Without a Supervisor token
// (a local run, the tests) every call is a no-op, so the rest of the app never needs to ask.
import { log } from '../util/log.mjs';

export function createHomeAssistant({ token = process.env.SUPERVISOR_TOKEN, baseUrl = 'http://supervisor/core/api', fetch: fetcher = fetch } = {}) {
  async function call(method, path, body) {
    if (!token) return false;
    try {
      const response = await fetcher(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) log.debug(`Home Assistant answered ${response.status} for ${method} ${path}`);
      return response.ok;
    } catch (error) {
      log.debug(`Home Assistant could not be reached for ${path}`, error);
      return false;
    }
  }

  return {
    available: Boolean(token),
    setState: (entityId, state, attributes = {}) => call('POST', `/states/${entityId}`, { state: String(state), attributes }),
    fireEvent: (type, data) => call('POST', `/events/${type}`, data),
    notify: ({ id, title, message }) => call('POST', '/services/persistent_notification/create', { notification_id: id, title, message }),
  };
}
