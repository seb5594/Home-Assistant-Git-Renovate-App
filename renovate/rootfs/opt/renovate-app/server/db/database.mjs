// SQLite through the driver that ships with Node.js (node:sqlite): no native module to build, nothing to
// install, and a database that stays small enough for the memory of a Raspberry Pi.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MIGRATION = /^(\d{3})_[a-z0-9_]+\.sql$/;

/** Applies every migration file newer than the schema version stored in the database. */
function migrate(db, folder) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  const pending = readdirSync(folder)
    .filter((name) => MIGRATION.test(name))
    .sort()
    .map((name) => ({ name, version: Number(name.slice(0, 3)) }))
    .filter(({ version }) => version > current);
  for (const { name, version } of pending) {
    // Rebuilding a table needs foreign keys off, and the setting cannot change inside a transaction.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(path.join(folder, name), 'utf8'));
      const broken = db.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error('the migration broke a foreign key');
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${name} failed: ${error.message}`);
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

/**
 * @param {string} file database file, or ':memory:'
 * @param {string} migrationsFolder folder with NNN_name.sql files
 */
export function openDatabase(file, migrationsFolder) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // WAL keeps readers away from the writer; NORMAL sync is safe with WAL and halves the writes on an SD card.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db, migrationsFolder);
  return db;
}

/** Runs `work` in one transaction. */
export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export const nowIso = () => new Date().toISOString();
export const parseJson = (text, fallback) => {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};
