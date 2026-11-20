// Run logs: one NDJSON file per run with compact entries, readable by byte offset so the web interface can
// load a finished log in pages and follow a running one without re-reading it.
import { appendFileSync, closeSync, existsSync, openSync, readSync, rmSync, statSync, mkdirSync, writeSync } from 'node:fs';
import path from 'node:path';

// Renovate's numeric (bunyan) levels, by name.
const LEVEL_NAMES = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
export const LEVEL_ORDER = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

// How much of a log one read looks at; larger logs are read in several calls.
const READ_WINDOW = 4 * 1024 * 1024;

// Details worth keeping next to the message; the rest of a Renovate record is bulky and rarely useful.
const DETAIL_KEYS = ['branch', 'prTitle', 'pr', 'depName', 'packageFile', 'manager', 'durationMs', 'datasource'];

/** Converts one line of Renovate's JSON output into a compact entry; plain text lines are kept as they are. */
export function toEntry(line, fallbackLevel = 'info', now = Date.now()) {
  const text = line.trimEnd();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      const record = JSON.parse(text);
      if (typeof record.msg === 'string' && typeof record.level === 'number') {
        const entry = { t: Date.parse(record.time) || now, l: LEVEL_NAMES[record.level] ?? 'info', m: record.msg };
        if (record.repository) entry.r = record.repository;
        const details = {};
        for (const key of DETAIL_KEYS) if (record[key] !== undefined) details[key] = record[key];
        if (record.err?.message) details.error = String(record.err.message).slice(0, 500);
        if (Object.keys(details).length) entry.x = details;
        return entry;
      }
    } catch {
      // Not JSON after all: fall through to plain text.
    }
  }
  return { t: now, l: fallbackLevel, m: text.slice(0, 2000) };
}

export function createLogStore({ dir, maxBytes = 20 * 1024 * 1024, emit = () => {} }) {
  mkdirSync(dir, { recursive: true });
  const fileOf = (runId) => path.join(dir, `${runId}.ndjson`);

  return {
    /** Opens a run's log for writing. Entries beyond `maxBytes` are dropped after one notice. */
    open(runId) {
      const fd = openSync(fileOf(runId), 'a', 0o600);
      let size = statSync(fileOf(runId)).size;
      let truncated = false;
      return {
        write(entry) {
          if (!entry) return;
          if (size >= maxBytes) {
            if (truncated) return;
            truncated = true;
            entry = { t: Date.now(), l: 'warn', m: 'The log reached its size limit; further lines are not stored.' };
          }
          const line = `${JSON.stringify(entry)}\n`;
          writeSync(fd, line);
          size += Buffer.byteLength(line);
          // The offset after this line lets a follower skip what it has already read from the file.
          emit(runId, entry, size);
        },
        close() {
          closeSync(fd);
        },
      };
    },

    /** Appends one entry to a log that is not open, for example the note that a run was interrupted. */
    append(runId, entry) {
      appendFileSync(fileOf(runId), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      emit(runId, entry, statSync(fileOf(runId)).size);
    },

    /**
     * @param {number} runId
     * @param {{offset?:number, limit?:number, level?:string}} options offset is a byte position from an earlier answer
     * @returns {{entries:object[], nextOffset:number, size:number}}
     */
    read(runId, { offset = 0, limit = 500, level = 'trace' } = {}) {
      const file = fileOf(runId);
      if (!existsSync(file)) return { entries: [], nextOffset: 0, size: 0 };
      const size = statSync(file).size;
      const start = Math.min(offset, size);
      const buffer = Buffer.alloc(Math.min(size - start, READ_WINDOW));
      const fd = openSync(file, 'r');
      try {
        readSync(fd, buffer, 0, buffer.length, start);
      } finally {
        closeSync(fd);
      }
      const minimum = LEVEL_ORDER.indexOf(level);
      const entries = [];
      let consumed = 0;
      let newline;
      // Only complete lines count; a line that is still being written is picked up by the next call.
      while (entries.length < limit && (newline = buffer.indexOf(0x0a, consumed)) !== -1) {
        const line = buffer.subarray(consumed, newline).toString('utf8');
        consumed = newline + 1;
        try {
          const entry = JSON.parse(line);
          if (LEVEL_ORDER.indexOf(entry.l) >= minimum) entries.push(entry);
        } catch {
          // A damaged line is skipped.
        }
      }
      return { entries, nextOffset: start + consumed, size };
    },

    sizeOf(runId) {
      const file = fileOf(runId);
      return existsSync(file) ? statSync(file).size : 0;
    },

    path: fileOf,

    remove(runId) {
      rmSync(fileOf(runId), { force: true });
    },
  };
}
