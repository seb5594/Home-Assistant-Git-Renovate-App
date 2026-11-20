// Runs the whole app on your machine without Home Assistant: a fake Gitea on port 3999 and a stand-in for
// Renovate, so the web interface can be developed and looked at in a browser.
//
//   node --disable-warning=ExperimentalWarning tools/dev-server.mjs [port]
//
// Open http://127.0.0.1:8099/ and connect "Gitea" with the address http://127.0.0.1:3999 and any token.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = path.join(root, 'renovate/rootfs/opt/renovate-app');
process.env.APP_ROOT = appRoot;
const { createApp } = await import(pathToFileURL(path.join(appRoot, 'server/app.mjs')).href);

const REPOSITORIES = ['sven/home-assistant-config', 'sven/esphome-devices', 'sven/ha-custom-card', 'sven/dotfiles', 'acme/website', 'acme/infrastructure']
  .map((full_name, index) => ({ full_name, description: index % 2 ? null : 'Example repository', html_url: `http://127.0.0.1:3999/${full_name}`, default_branch: 'main', private: index % 3 === 0, fork: index === 3, archived: index === 5, permissions: { push: true } }));

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

http.createServer((req, res) => {
  const json = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const { pathname } = new URL(req.url, 'http://x');
  // The OAuth endpoints of the fake Gitea, for the sign-in through the browser.
  if (pathname === '/login/oauth/access_token') return json({ access_token: 'dev-token', refresh_token: 'dev-refresh', expires_in: 3600 });
  if (pathname === '/api/v1/version') return json({ version: '1.22.0' });
  if (pathname === '/api/v1/user') return json({ id: 1, login: 'sven', full_name: 'Sven Example', email: 'sven@example.com', avatar_url: 'http://127.0.0.1:3999/avatar.png' });
  if (pathname === '/api/v1/user/repos') return json(REPOSITORIES);
  if (pathname.endsWith('/tokens')) return json({ id: 1, sha1: 'dev-token' }, 201);
  if (pathname.endsWith('/hooks')) return json(req.method === 'POST' ? {} : [], req.method === 'POST' ? 201 : 200);
  if (pathname === '/avatar.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(PIXEL);
  }
  return json({ message: 'not found' }, 404);
}).listen(3999, '127.0.0.1');

const dir = mkdtempSync(path.join(os.tmpdir(), 'renovate-dev-'));
writeFileSync(path.join(dir, 'renovate-package.json'), JSON.stringify({ version: '44.256.1' }));
writeFileSync(path.join(dir, 'version'), '2026.11.20\n');

const options = process.env.DEV_OPTIONS ? JSON.parse(process.env.DEV_OPTIONS) : {};
const app = await createApp({
  options,
  port: Number(process.argv[2] ?? 8099),
  allowedAddresses: null,
  versionFile: path.join(dir, 'version'),
  paths: {
    appRoot, ui: path.join(appRoot, 'ui'), migrations: path.join(appRoot, 'db'), data: dir, options: path.join(dir, 'options.json'), database: path.join(dir, 'dev.db'),
    keyFile: path.join(dir, 'keys/secret.key'), runs: path.join(dir, 'runs'), cache: path.join(dir, 'cache'), work: path.join(dir, 'work'), userConfig: path.join(dir, 'config'), ssl: path.join(dir, 'ssl'),
    renovateBin: path.join(root, '.github/tests/unit/fixtures/fake-renovate.mjs'), renovatePackage: path.join(dir, 'renovate-package.json'),
  },
  databaseFile: path.join(dir, 'dev.db'),
});
await app.start();
console.log(`Dev server: http://127.0.0.1:${app.server.address().port}/  (fake Gitea: http://127.0.0.1:3999, data: ${dir})`);
