// The listener for webhook deliveries. It is a separate server on its own port, because the web interface
// is only reachable through Home Assistant's ingress, while the git servers need a plain address.
import http from 'node:http';
import { readBody } from '../http/router.mjs';
import { AppError } from '../util/errors.mjs';
import { log } from '../util/log.mjs';

const MAX_DELIVERY_BYTES = 5 * 1024 * 1024;

export function createWebhookServer({ intake, settings }) {
  let server = null;
  let listeningPort = null;

  async function handle(req, res) {
    const send = (status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    };
    try {
      const match = /^\/hooks\/([A-Za-z0-9]+)$/.exec(new URL(req.url, 'http://localhost').pathname);
      if (!match) return send(404, { error: 'not_found' });
      if (req.method !== 'POST') return send(405, { error: 'method_not_allowed' });
      const rawBody = await readBody(req, MAX_DELIVERY_BYTES);
      const { status, body } = intake.handle({ connectionId: match[1], headers: req.headers, rawBody });
      return send(status, body);
    } catch (error) {
      if (error instanceof AppError) return send(error.status, { error: error.code });
      log.error('A webhook delivery failed', error);
      return send(500, { error: 'internal_error' });
    }
  }

  return {
    /** Starts, moves or stops the listener to match the current settings. */
    async apply() {
      const wanted = settings.get('webhooks.enabled') ? settings.get('webhooks.port') : null;
      if (server && wanted === listeningPort) return;
      if (server) {
        await new Promise((resolve) => server.close(resolve));
        server = null;
        listeningPort = null;
      }
      if (wanted === null) return;
      const next = http.createServer(handle);
      next.headersTimeout = 15_000;
      next.requestTimeout = 30_000;
      try {
        await new Promise((resolve, reject) => {
          next.once('error', reject);
          next.listen(wanted, '0.0.0.0', resolve);
        });
      } catch (error) {
        log.error(`The webhook listener cannot use port ${wanted}`, error);
        return;
      }
      next.on('error', (error) => log.error('The webhook listener failed', error));
      server = next;
      listeningPort = wanted;
      log.info(`Webhooks are received on port ${wanted}`);
    },
    status: () => ({ enabled: settings.get('webhooks.enabled'), port: settings.get('webhooks.port'), listening: server !== null }),
    address: () => server?.address() ?? null,
    async stop() {
      if (!server) return;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      server = null;
      listeningPort = null;
    },
  };
}
