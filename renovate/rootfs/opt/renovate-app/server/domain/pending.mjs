// Short-lived, in-memory holding place for credentials that were obtained but not yet saved: a token
// verified in the setup wizard, a device sign-in in progress. Nothing here is written to disk, and nothing
// is sent back to the browser: the wizard only gets an opaque id.
import { randomId } from '../security/crypto.mjs';
import { badRequest } from '../util/errors.mjs';

export function createPendingStore({ ttlMs = 15 * 60_000, now = Date.now } = {}) {
  const entries = new Map();

  const sweep = () => {
    for (const [id, entry] of entries) if (entry.expiresAt <= now()) entries.delete(id);
  };

  return {
    put(data) {
      sweep();
      const id = randomId(12);
      entries.set(id, { data, expiresAt: now() + ttlMs });
      return id;
    },
    /** Reads an entry without removing it (polling a device sign-in). */
    peek(id) {
      sweep();
      const entry = entries.get(id);
      if (!entry) throw badRequest('expired', 'This step has expired. Please start again.');
      return entry.data;
    },
    /** Reads an entry and removes it: a credential can be used once. */
    take(id) {
      const data = this.peek(id);
      entries.delete(id);
      return data;
    },
    replace(id, data) {
      const entry = entries.get(id);
      if (entry) entry.data = data;
    },
    size: () => entries.size,
  };
}
