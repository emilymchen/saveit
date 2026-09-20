/**
 * Shapes for the Instagram Messaging webhook.
 *
 * Two different envelopes carry the same inner event shape, depending on which
 * Instagram product delivered it:
 *   - Messenger-style: `entry[].messaging[]` — used by Instagram via Facebook Login.
 *   - Graph API "changes" style: `entry[].changes[]` with `field: "messages"` and
 *     the event under `.value` — used by the standalone Instagram API (Instagram
 *     Login / Instagram Business Login). Confirmed against a real webhook payload
 *     from the Meta dashboard's "Test" sender.
 * `extractEvents` in normalize.ts flattens both into the same event shape.
 * Everything here is optional because Meta adds fields without warning; the
 * normalizer is responsible for deciding what is usable.
 */

export interface IgAttachmentPayload {
  url?: string;
  title?: string;
  /** Present on reshared posts/reels: the IG media id, when Meta chooses to include it. */
  id?: string;
}

export interface IgAttachment {
  /** image | video | audio | file | share | story_mention | ig_reel | template | fallback */
  type?: string;
  payload?: IgAttachmentPayload;
}

export interface IgMessage {
  mid?: string;
  text?: string;
  /** True when the event is our OWN outbound message reflected back to us. */
  is_echo?: boolean;
  is_deleted?: boolean;
  is_unsupported?: boolean;
  attachments?: IgAttachment[];
  reply_to?: { mid?: string; story?: { url?: string; id?: string } };
  referral?: { ref?: string; source?: string; type?: string };
}

export interface IgMessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  // Messenger-style delivery sends epoch milliseconds as a number; the
  // "changes"-style envelope (see below) sends epoch seconds as a string.
  timestamp?: number | string;
  message?: IgMessage;
  /** Present on read/delivery/reaction/postback events, which we ignore for now. */
  read?: unknown;
  delivery?: unknown;
  reaction?: unknown;
  postback?: unknown;
}

/** One entry in the Graph API "changes" envelope; `value` shares IgMessagingEvent's shape when field is "messages". */
export interface IgChange {
  field?: string;
  value?: IgMessagingEvent;
}

export interface IgEntry {
  id?: string;
  time?: number;
  messaging?: IgMessagingEvent[];
  changes?: IgChange[];
}

export interface IgWebhookBody {
  object?: string;
  entry?: IgEntry[];
}

/** A link the user shared, pulled from message text or an attachment. */
export interface SharedLink {
  url: string;
  platform: 'instagram' | 'tiktok' | 'other';
  source: 'text' | 'attachment';
}

/**
 * One inbound DM, flattened into the only shape the rest of the pipeline sees.
 * Everything downstream (AI parsing, place resolution, persistence) consumes this
 * and never touches Meta's envelope.
 */
export interface NormalizedMessage {
  /** Meta's message id. Stable across retries, so it is our idempotency key. */
  mid: string;
  /** Instagram-scoped sender id (IGSID). NOT a SaveIt user id — see the linking flow. */
  senderIgsid: string;
  /** Our bot account's IGSID. */
  recipientIgsid: string;
  sentAt: Date;
  text: string | null;
  attachments: IgAttachment[];
  links: SharedLink[];
  /** True when the user replied to one of our story posts. */
  isStoryReply: boolean;
  /** The full original event, retained for replay and debugging. */
  raw: IgMessagingEvent;
}

/** Why an event was dropped before reaching the parser. */
export type SkipReason =
  | 'echo'
  | 'deleted'
  | 'unsupported'
  | 'no-message'
  | 'missing-ids'
  | 'empty'
  | 'duplicate';
