// Serves the web interface from memory. The files are small, so they are read once, compressed once and
// answered with an ETag: after the first visit a reload costs a 304.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// The page may not load anything from elsewhere. Avatars come through the app itself.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

function* walk(directory) {
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    if (statSync(file).isDirectory()) yield* walk(file);
    else yield file;
  }
}

export function createStaticServer(root) {
  const files = new Map();
  for (const file of walk(root)) {
    const relative = `/${path.relative(root, file).split(path.sep).join('/')}`;
    const body = readFileSync(file);
    const type = TYPES[path.extname(file)];
    if (!type) continue;
    const compressible = /^(text|application\/json|image\/svg)/.test(type);
    files.set(relative, {
      type,
      body,
      gzip: compressible ? gzipSync(body, { level: 9 }) : null,
      etag: `"${createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`,
    });
  }

  return async function serve(req, res, url) {
    const entry = files.get(url.pathname === '/' ? '/index.html' : url.pathname);
    if (!entry) return false;
    const headers = {
      'Content-Type': entry.type,
      ETag: entry.etag,
      // The interface changes with every release, so the browser asks each time and gets a cheap 304.
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      Vary: 'Accept-Encoding',
    };
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    const useGzip = entry.gzip && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    const body = useGzip ? entry.gzip : entry.body;
    res.writeHead(200, { ...headers, ...(useGzip ? { 'Content-Encoding': 'gzip' } : {}), 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
