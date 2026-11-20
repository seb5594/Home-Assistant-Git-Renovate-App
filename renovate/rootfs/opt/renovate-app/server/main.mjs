// Entry point: starts the app and stops it cleanly when the Supervisor asks.
import { createApp } from './app.mjs';
import { paths } from './paths.mjs';
import { log } from './util/log.mjs';

const INGRESS_PORT = Number(process.env.INGRESS_PORT ?? 8099);

let app;
try {
  app = await createApp({ paths, port: INGRESS_PORT, allowedAddresses: process.env.ALLOW_ANY_SOURCE === '1' ? null : undefined });
  await app.start();
} catch (error) {
  log.error('The app could not start', error);
  process.exit(1);
}

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    log.info('Shutting down');
    await app.stop().catch((error) => log.error('Shutdown was not clean', error));
    process.exit(0);
  });
}

process.on('unhandledRejection', (error) => log.error('Unhandled error', error));
