// A small router and the request plumbing around it: body parsing, error mapping, the ingress guard and
// the CSRF header. Handlers return plain objects; the router turns them into JSON answers.
import { AppError, badRequest } from '../util/errors.mjs';
import { log } from '../util/log.mjs';

/** Home Assistant's ingress gateway: the only address allowed to reach the interface. */
export const INGRESS_ADDRESSES = ['172.30.32.2', '::ffff:172.30.32.2'];
const LOCAL_ADDRESSES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
// A browser cannot add this header to a cross-site form post, so requiring it blocks CSRF.
export const REQUEST_HEADER = 'x-requested-with';
export const REQUEST_HEADER_VALUE = 'renovate-ui';
const MAX_BODY_BYTES = 1024 * 1024;

/** Marker a handler returns after it wrote the response itself (streams, files). */
export const HANDLED = Symbol('handled');

export function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

export async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AppError(413, 'body_too_large', 'The request is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const compile = (pattern) => {
  const names = [];
  const source = pattern.replace(/:([A-Za-z]+)/g, (_, name) => {
    names.push(name);
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${source}$`), names };
};

export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, handler) {
      routes.push({ method, ...compile(pattern), handler });
    },
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const found = route.regex.exec(pathname);
        if (found) return { handler: route.handler, params: Object.fromEntries(route.names.map((name, index) => [name, decodeURIComponent(found[index + 1])])) };
      }
      return null;
    },
    hasPath(pathname) {
      return routes.some((route) => route.regex.test(pathname));
    },
  };
}

/**
 * @param {object} options
 * @param {ReturnType<typeof createRouter>} options.router
 * @param {(req, res, url) => boolean|Promise<boolean>} options.serveStatic returns true when it answered
 * @param {string[]|null} options.allowedAddresses null disables the source check (tests, local development)
 */
export function createRequestHandler({ router, serveStatic, allowedAddresses }) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const isHealth = url.pathname === '/api/health';
    try {
      const remote = req.socket.remoteAddress;
      if (!isHealth && allowedAddresses && !allowedAddresses.includes(remote) && !LOCAL_ADDRESSES.includes(remote)) {
        throw new AppError(403, 'forbidden_source', 'This interface is only reachable through Home Assistant');
      }
      if (url.pathname.startsWith('/api/')) {
        const match = router.match(req.method, url.pathname);
        if (!match) {
          throw router.hasPath(url.pathname) ? new AppError(405, 'method_not_allowed', 'Method not allowed') : new AppError(404, 'not_found', 'Unknown endpoint');
        }
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers[REQUEST_HEADER] !== REQUEST_HEADER_VALUE) {
          throw new AppError(403, 'missing_request_header', 'The request header X-Requested-With is required');
        }
        let body = null;
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
          const raw = await readBody(req);
          if (raw.length) {
            try {
              body = JSON.parse(raw.toString('utf8'));
            } catch {
              throw badRequest('invalid_json', 'The request body is not valid JSON');
            }
          }
        }
        const result = await match.handler({ req, res, params: match.params, query: url.searchParams, body: body ?? {} });
        if (result !== HANDLED) sendJson(res, 200, result ?? { ok: true });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new AppError(405, 'method_not_allowed', 'Method not allowed');
      if (!(await serveStatic(req, res, url))) throw new AppError(404, 'not_found', 'Not found');
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof AppError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message, details: error.details } });
        return;
      }
      log.error(`Unexpected error on ${req.method} ${url.pathname}`, error);
      sendJson(res, 500, { error: { code: 'internal_error', message: 'Something went wrong. See the app log.' } });
    }
  };
}
