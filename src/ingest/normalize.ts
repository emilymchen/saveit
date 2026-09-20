import type {
  IgMessagingEvent,
  IgWebhookBody,
  NormalizedMessage,
  SharedLink,
  SkipReason,
} from './types.js';

export type NormalizeResult =
  | { ok: true; message: NormalizedMessage }
  | { ok: false; reason: SkipReason; mid?: string };

const URL_PATTERN = /https?:\/\/[^\s<>"')]+/gi;

function classifyLink(url: string): SharedLink['platform'] {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  // Match on exact host or subdomain boundary so "nottiktok.com" is not a match.
  const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);

  if (matches('instagram.com') || matches('instagr.am')) return 'instagram';
  if (matches('tiktok.com')) return 'tiktok';
  return 'other';
}

/** Trailing punctuation is almost always sentence punctuation, not part of the URL. */
function trimTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?]+$/, '');
}

function extractLinks(event: IgMessagingEvent): SharedLink[] {
  const seen = new Set<string>();
  const links: SharedLink[] = [];

  const add = (rawUrl: string | undefined, source: SharedLink['source']) => {
    if (!rawUrl) return;
    const url = trimTrailingPunctuation(rawUrl.trim());
    if (!url || seen.has(url)) return;
    seen.add(url);
    links.push({ url, platform: classifyLink(url), source });
  };

  for (const match of event.message?.text?.match(URL_PATTERN) ?? []) {
    add(match, 'text');
  }
  for (const attachment of event.message?.attachments ?? []) {
    add(attachment.payload?.url, 'attachment');
  }

  return links;
}

/**
 * Collapse one Meta messaging event into a NormalizedMessage, or explain why it
 * cannot be used. Filtering here — rather than in the route — keeps the drop
 * rules testable and in one place.
 */
export function normalizeEvent(event: IgMessagingEvent): NormalizeResult {
  const message = event.message;

  // Read receipts, delivery confirmations, reactions and postbacks share the
  // envelope but carry no message body.
  if (!message) return { ok: false, reason: 'no-message' };

  // Echoes are our own outbound messages reflected back. Processing them makes
  // the bot ingest its own replies.
  if (message.is_echo) return { ok: false, reason: 'echo', mid: message.mid };
  if (message.is_deleted) return { ok: false, reason: 'deleted', mid: message.mid };

  // Meta sends is_unsupported for content it cannot render for us (some story
  // types, expired media). There is nothing to parse.
  if (message.is_unsupported) return { ok: false, reason: 'unsupported', mid: message.mid };

  const mid = message.mid;
  const senderIgsid = event.sender?.id;
  const recipientIgsid = event.recipient?.id;
  if (!mid || !senderIgsid || !recipientIgsid) return { ok: false, reason: 'missing-ids', mid };

  const text = message.text?.trim() || null;
  const attachments = message.attachments ?? [];
  const links = extractLinks(event);

  // A message with no text, no attachment and no link has nothing to extract from.
  if (!text && attachments.length === 0 && links.length === 0) {
    return { ok: false, reason: 'empty', mid };
  }

  return {
    ok: true,
    message: {
      mid,
      senderIgsid,
      recipientIgsid,
      sentAt: parseEventTimestamp(event.timestamp),
      text,
      attachments,
      links,
      isStoryReply: Boolean(message.reply_to?.story),
      raw: event,
    },
  };
}

/**
 * Flatten a webhook body into its individual messaging events.
 *
 * Handles both delivery envelopes: Messenger-style `entry[].messaging[]`, and
 * the Graph API "changes" style used by the standalone Instagram API, where
 * the event lives at `entry[].changes[].value` under `field: "messages"`.
 */
export function extractEvents(body: IgWebhookBody): IgMessagingEvent[] {
  return (body.entry ?? []).flatMap((entry) => [
    ...(entry.messaging ?? []),
    ...(entry.changes ?? [])
      .filter((change) => change.field === 'messages' && change.value)
      .map((change) => change.value as IgMessagingEvent),
  ]);
}

/**
 * Meta's timestamp field is inconsistent across envelopes: epoch milliseconds
 * as a number on Messenger-style delivery, epoch *seconds* as a string on the
 * "changes"-style envelope. Anything under 1e12 cannot be milliseconds since
 * that would predate the epoch's early years by decades, so treat it as seconds.
 */
function parseEventTimestamp(timestamp: number | string | undefined): Date {
  if (timestamp === undefined) return new Date();
  const n = typeof timestamp === 'string' ? Number(timestamp) : timestamp;
  if (!Number.isFinite(n)) return new Date();
  return new Date(n < 1e12 ? n * 1000 : n);
}
