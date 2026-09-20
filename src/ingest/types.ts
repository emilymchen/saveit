/**
 * Shapes for the Instagram Messaging webhook.
 *
 * Note that Instagram DM events use the Messenger-style `entry[].messaging[]`
 * envelope, NOT the `entry[].changes[]` envelope used by comment/mention events.
 * Everything here is optional because Meta adds fields without warning; the
 * normalizer is responsible for deciding what is usable.
 */

export interface IgAttachmentPayload {
  url?: string;
  /**
   * Documented on ig_post / ig_reel / fallback, but Meta only calls it "Title of
   * the attachment" — never the caption, and the Instagram-specific docs claim
   * only the URL is delivered. Treat as opportunistic; never depend on it.
   */
  title?: string;
  /** Media id, on post / ig_post. */
  id?: string;
  /** On reel / ig_reel. */
  reel_video_id?: string;
}

export interface IgAttachment {
  /**
   * Meta's documented set: audio | file | image | sticker | video | fallback |
   * reel | ig_reel | post | ig_post | appointment_booking | template.
   * Note there is no "share" type, despite it being an obvious guess.
   */
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
  timestamp?: number;
  message?: IgMessage;
  /** Present on read/delivery/reaction/postback events, which we ignore for now. */
  read?: unknown;
  delivery?: unknown;
  reaction?: unknown;
  postback?: unknown;
}

export interface IgEntry {
  id?: string;
  time?: number;
  messaging?: IgMessagingEvent[];
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
  /**
   * `media` is bytes we can fetch and look at; `permalink` is a page we cannot
   * read (Instagram login-walls non-browser clients). This split decides whether
   * the parser has anything to work with.
   */
  kind: 'media' | 'permalink' | 'other';
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
