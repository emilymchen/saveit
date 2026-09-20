import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { logger } from './lib/logger.js';
import { webhookRouter } from './routes/webhook.js';

export function createApp(): Express {
  const app = express();

  // Meta sits behind our reverse proxy / tunnel, so trust X-Forwarded-For for req.ip.
  app.set('trust proxy', true);

  app.use(
    express.json({
      // Capture the untouched bytes before parsing. The HMAC in
      // X-Hub-Signature-256 is computed over these exact bytes.
      verify: (req: Request, _res, buf: Buffer) => {
        req.rawBody = buf;
      },
      // Webhook payloads are small; a cap keeps a malformed or hostile request
      // from buffering unbounded memory.
      limit: '1mb',
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.use('/webhook', webhookRouter);

  app.use((_req, res) => {
    res.sendStatus(404);
  });

  // Four-arg signature is what marks this as Express's error handler.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('unhandled request error', { error: err.message, stack: err.stack });
    if (!res.headersSent) res.sendStatus(500);
  });

  return app;
}
