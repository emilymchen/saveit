import { Router, type Request, type Response } from 'express';
import { config, isProd } from '../config.js';
import { logger } from '../lib/logger.js';
import { isValidSignature } from '../lib/signature.js';
import { processWebhookBody } from '../ingest/process.js';
import { persistRawEvent } from '../ingest/rawEvents.js';
import type { IgWebhookBody } from '../ingest/types.js';

export const webhookRouter: Router = Router();

/**
 * Verification handshake.
 *
 * Meta calls this once when you save the callback URL in the App Dashboard. It
 * sends our verify token back to us; we echo `hub.challenge` verbatim to prove
 * we own the endpoint. The challenge must be returned as plain text — wrapping
 * it in JSON fails the handshake.
 */
webhookRouter.get('/', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.IG_VERIFY_TOKEN && typeof challenge === 'string') {
    logger.info('webhook verification succeeded');
    res.type('text/plain').status(200).send(challenge);
    return;
  }

  logger.warn('webhook verification failed', { mode, tokenMatched: token === config.IG_VERIFY_TOKEN });
  res.sendStatus(403);
});

/**
 * Event delivery.
 *
 * Order matters: reject unsigned requests, acknowledge immediately, then work.
 * Meta retries anything slow or non-2xx, so all real processing happens after
 * the response is flushed.
 */
webhookRouter.post('/', (req: Request, res: Response) => {
  const rawBody = req.rawBody;

  if (!rawBody) {
    // Only possible if the body parser was misconfigured or the body was empty.
    logger.error('webhook POST had no raw body — cannot verify signature');
    res.sendStatus(400);
    return;
  }

  if (!isValidSignature(rawBody, req.get('x-hub-signature-256'), config.META_APP_SECRET)) {
    logger.warn('webhook POST rejected: invalid signature', {
      ip: req.ip,
      hasSignatureHeader: Boolean(req.get('x-hub-signature-256')),
      // A wrong META_APP_SECRET is indistinguishable from a forged request at
      // the crypto level, and it is by far the likelier cause during setup.
      ...(isProd ? {} : { hint: 'if this was a real Meta delivery, check META_APP_SECRET matches your app' }),
    });
    res.sendStatus(403);
    return;
  }

  const body = req.body as IgWebhookBody;

  // Instagram DMs arrive with object "instagram". Anything else is a subscription
  // we did not intend; acknowledge it so Meta stops retrying, but do no work.
  if (body.object !== 'instagram') {
    logger.warn('ignoring webhook for unexpected object', { object: body.object });
    res.sendStatus(200);
    return;
  }

  persistRawEvent(body);
  res.sendStatus(200);

  // Deliberately not awaited: the response is already sent.
  void processWebhookBody(body).catch((err) => {
    logger.error('unhandled error processing webhook', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
});
