import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { APP_ROOT, load } from './helpers.mjs';

const { openDatabase } = await load('db/database.mjs');

test('an existing database from the first release is upgraded without losing connections, repositories or runs', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'old.db');
  // The database as version 1 created it.
  const old = new DatabaseSync(file);
  old.exec(readFileSync(path.join(APP_ROOT, 'db/001_initial.sql'), 'utf8'));
  old.exec('PRAGMA user_version = 1');
  old.exec(`INSERT INTO connections (id, name, provider, endpoint, token_enc, webhook_secret, created_at, updated_at) VALUES ('c1', 'Home', 'gitea', 'http://g/api/v1/', 'v1:x', 's', 't', 't')`);
  // A connection that came from the (removed) connections option of the app configuration.
  old.exec(`INSERT INTO connections (id, name, provider, endpoint, token_enc, webhook_secret, managed, created_at, updated_at) VALUES ('c0', 'From options', 'gitea', 'http://g/api/v1/', 'v1:z', 's', 1, 't', 't')`);
  old.exec(`INSERT INTO repositories (connection_id, full_name) VALUES ('c1', 'a/b')`);
  old.exec(`INSERT INTO runs (connection_id, connection_name, trigger, status, queued_at) VALUES ('c1', 'Home', 'manual', 'succeeded', 't')`);
  old.close();

  const db = openDatabase(file, path.join(APP_ROOT, 'db'));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM repositories WHERE connection_id = 'c1'").get().n, 1);
  assert.equal(db.prepare("SELECT managed FROM connections WHERE id = 'c0'").get().managed, 0, 'connections of the removed option become ordinary ones');
  assert.equal(db.prepare("SELECT connection_id FROM runs").get().connection_id, 'c1');
  // The new server types and columns work, and deleting a connection still cascades to its repositories.
  db.exec(`INSERT INTO connections (id, name, provider, username, token_enc, webhook_secret, created_at, updated_at) VALUES ('c2', 'Bitbucket', 'bitbucket', 'me', 'v1:y', 's', 't', 't')`);
  db.exec(`INSERT INTO repositories (connection_id, full_name) VALUES ('c2', 'w/r')`);
  db.exec("DELETE FROM connections WHERE id = 'c2'");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM repositories WHERE connection_id = 'c2'").get().n, 0);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  db.close();
});
