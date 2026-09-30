import { logger } from '../lib/logger.js';
import { parseMessage } from '../parse/index.js';
import { isDuplicate } from './dedupe.js';
import { tryHandleLinkCode } from './linking.js';
import { extractEvents, normalizeEvent } from './normalize.js';
import { insertMessage, insertSaves, updateMessageFollowup, upsertSender } from './persist.js';
import type { IgWebhookBody, NormalizedMessage } from './types.js';

/**
 * Runs AFTER the 200 has already been sent to Meta.
 *
 * Meta expects a response within seconds and retries on timeout, so the route
 * acknowledges immediately and hands the body here. Nothing in this path may
 * throw into the request lifecycle — every message is isolated.
 *
 * Next milestone: DM the sender a confirmation, or a question when
 * needsFollowup is set. Persistence (this function) now lands before that.
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

    // Fast path only: catches a retry within this process's lifetime without
    // a DB round trip. insertMessage()'s unique constraint below is the
    // durable guard that survives a restart.
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

async function handleMessage(message: NormalizedMessage): Promise<void> {
  logger.info('inbound DM', {
    mid: message.mid,
    from: message.senderIgsid,
    sentAt: message.sentAt.toISOString(),
    text: message.text,
    // Raw events are not persisted in production, so this is the only record of
    // which fields Meta actually sends per attachment type. ig_post delivers a
    // fetchable lookaside media URL; ig_reel delivers a permalink we cannot
    // read, so whether it carries a usable media id elsewhere matters.
    attachments: message.attachments.map((a) => ({
      type: a.type,
      payload: Object.fromEntries(
        Object.entries(a.payload ?? {}).map(([k, v]) => [
          k,
          typeof v === 'string' && v.length > 140 ? `${v.slice(0, 140)}…` : v,
        ]),
      ),
    })),
    titles: message.attachments.map((a) => a.payload?.title).filter(Boolean),
    links: message.links.map((l) => `${l.platform}/${l.kind}:${l.url}`),
    isStoryReply: message.isStoryReply,
  });

  // A link code ("DM this to connect your account") is a command, never a
  // place to save — checked and short-circuited before anything else touches
  // this message, so it can never reach Claude/Places.
  if (await tryHandleLinkCode(message)) return;

  await upsertSender(message.senderIgsid);

  // Inserted before parsing, on purpose: this is the durable dedupe guard, so
  // it must land before any Claude/Places calls, or a retried delivery after
  // a restart (in-memory map above empty) would pay for a second parse.
  const inserted = await insertMessage(message);
  if (inserted.duplicate) {
    logger.debug('skipped event', { reason: 'duplicate-db', mid: message.mid });
    return;
  }

  const result = await parseMessage(message);
  await updateMessageFollowup(inserted.id, result.needsFollowup, result.reason);

  if (result.needsFollowup) {
    logger.info('save needs follow-up', { mid: message.mid, reason: result.reason });
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

  await insertSaves(inserted.id, message.senderIgsid, result.places);
}
