import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './lib/logger.js';

const app = createApp();

const server = app.listen(config.PORT, () => {
  logger.info(`SaveIt ingestion server listening on :${config.PORT}`, {
    env: config.NODE_ENV,
    persistRawEvents: config.PERSIST_RAW_EVENTS,
  });
});

// A dropped webhook is a lost save, so drain in-flight requests before exiting.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection', {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});
