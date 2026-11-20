// Every location the app touches, in one place. Environment variables exist for tests and local runs.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = process.env.APP_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = process.env.DATA_DIR ?? '/data';

// When the server runs as root (it does in the container), every Renovate process starts as this user instead.
const runAsUid = Number(process.env.RUN_AS_UID);
const runAsGid = Number(process.env.RUN_AS_GID);
const runAs = process.getuid?.() === 0 && Number.isInteger(runAsUid) && runAsUid > 0 ? { uid: runAsUid, gid: Number.isInteger(runAsGid) ? runAsGid : runAsUid } : null;

export const paths = Object.freeze({
  appRoot,
  runAs,
  ui: path.join(appRoot, 'ui'),
  migrations: path.join(appRoot, 'db'),
  data,
  options: process.env.OPTIONS_FILE ?? path.join(data, 'options.json'),
  // In a folder of its own: SQLite creates journal files next to the database, so the folder must be writable.
  database: path.join(data, 'db', 'renovate-app.db'),
  keyFile: path.join(data, 'keys', 'secret.key'),
  runs: path.join(data, 'runs'),
  // Package lookups are worth keeping between runs; the clones are not.
  cache: process.env.CACHE_DIR ?? path.join(data, 'cache'),
  work: process.env.WORK_DIR ?? '/tmp/renovate-work',
  // The app's own configuration folder, visible as /addon_configs/<id>_renovate on the host.
  userConfig: process.env.USER_CONFIG_DIR ?? '/config',
  ssl: process.env.SSL_DIR ?? '/ssl',
  renovateBin: process.env.RENOVATE_BIN ?? '/opt/renovate/node_modules/renovate/dist/renovate.js',
  renovatePackage: process.env.RENOVATE_PACKAGE ?? '/opt/renovate/node_modules/renovate/package.json',
});
