// Shared helpers of the unit tests. APP_ROOT points at the application folder: the rootfs of the
// repository when the tests run on a checkout, /opt/renovate-app when they run inside the built image.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = process.env.APP_ROOT ?? path.resolve(here, '../../../renovate/rootfs/opt/renovate-app');
process.env.APP_ROOT = APP_ROOT;

/** Imports a module of the application by its path below server/. */
export const load = (relative) => import(pathToFileURL(path.join(APP_ROOT, 'server', relative)).href);

/** A temporary folder that is removed when the test file ends. */
export function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'renovate-app-test-'));
  t?.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An in-memory database with every migration applied. */
export async function memoryDatabase() {
  const { openDatabase } = await load('db/database.mjs');
  return openDatabase(':memory:', path.join(APP_ROOT, 'db'));
}

/** A vault with a fixed key, so tests can compare ciphertext behavior without touching the disk. */
export async function testVault() {
  const { createVault } = await load('security/crypto.mjs');
  return createVault(Buffer.alloc(32, 7));
}
