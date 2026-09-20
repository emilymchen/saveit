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
      // Meta sends epoch milliseconds; fall back to arrival time if absent.
      sentAt: new Date(event.timestamp ?? Date.now()),
      text,
      attachments,
      links,
      isStoryReply: Boolean(message.reply_to?.story),
      raw: event,
    },
  };
}

/** Flatten a webhook body into its individual messaging events. */
export function extractEvents(body: IgWebhookBody): IgMessagingEvent[] {
  return (body.entry ?? []).flatMap((entry) => entry.messaging ?? []);
}
