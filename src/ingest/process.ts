import { logger } from '../lib/logger.js';
import { parseMessage } from '../parse/index.js';
import { isDuplicate } from './dedupe.js';
import { extractEvents, normalizeEvent } from './normalize.js';
import type { IgWebhookBody, NormalizedMessage } from './types.js';

/**
 * Runs AFTER the 200 has already been sent to Meta.
 *
 * Meta expects a response within seconds and retries on timeout, so the route
 * acknowledges immediately and hands the body here. Nothing in this path may
 * throw into the request lifecycle — every message is isolated.
 *
 * Today this is an in-process call. When AI parsing lands it becomes real work
 * (an OpenAI round trip, a Places lookup, a DB write) and should move behind a
 * durable queue — pg-boss on the Supabase database is the natural next step —
 * so a crash mid-parse does not silently drop a user's save.
 */
export async function processWebhookBody(body: IgWebhookBody): Promise<void> {
  const events = extractEvents(body);

  if (events.length === 0) {
    logger.debug('webhook contained no messaging events', { object: body.object });
    return;
  }

  for (const event of events) {
    const result = normalizeEvent(event);

    if (!result.ok) {
      logger.debug('skipped event', { reason: result.reason, mid: result.mid });
      continue;
    }

    const message = result.message;

    if (isDuplicate(message.mid)) {
      logger.debug('skipped event', { reason: 'duplicate', mid: message.mid });
      continue;
    }

    try {
      await handleMessage(message);
    } catch (err) {
      // One bad message must not stop the rest of the batch.
      logger.error('failed to handle message', {
        mid: message.mid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * The seam where the rest of the pipeline plugs in.
 *
 * Next milestones, in order:
 *   1. upsert the sender (IGSID) and persist the message + result to Supabase
 *   2. DM the sender a confirmation, or a question when needsFollowup is set
 */
async function handleMessage(message: NormalizedMessage): Promise<void> {
  logger.info('inbound DM', {
    mid: message.mid,
    from: message.senderIgsid,
    sentAt: message.sentAt.toISOString(),
    text: message.text,
    attachments: message.attachments.map((a) => a.type),
    links: message.links.map((l) => `${l.platform}/${l.kind}:${l.url}`),
    isStoryReply: message.isStoryReply,
  });

  const result = await parseMessage(message);

  if (result.needsFollowup) {
    logger.info('save needs follow-up', { mid: message.mid, reason: result.reason });
    return;
  }

  for (const { candidate, resolved } of result.places) {
    logger.info('parsed save', {
      mid: message.mid,
      name: resolved?.name ?? candidate.placeName,
      address: resolved?.address ?? null,
      placeId: resolved?.placeId ?? null,
      evidence: candidate.evidence,
    });
  }
}
