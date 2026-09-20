import type { NormalizedMessage } from '../ingest/types.js';

/**
 * Everything we know about one shared post, flattened for the extractor.
 *
 * `media` is the signal that matters: Meta gives us no caption, and the
 * Instagram docs say only a URL is delivered, so the place name usually has to
 * be read off the pixels. Text is opportunistic enrichment.
 */
export interface SignalBundle {
  /** What the sender typed alongside the share. */
  userNote: string | null;
  /** Attachment `title` values, when Meta includes them. Often absent. */
  titles: string[];
  /** Bytes we can look at — a CDN URL, or a local path when run from the CLI. */
  media: string[];
  /** Pages we cannot read — kept for the record, not for parsing. */
  permalinks: string[];
}

export function gatherSignals(message: NormalizedMessage): SignalBundle {
  const titles = message.attachments
    .map((a) => a.payload?.title?.trim())
    .filter((t): t is string => Boolean(t));

  return {
    userNote: message.text,
    titles,
    media: message.links.filter((l) => l.kind === 'media').map((l) => l.url),
    permalinks: message.links.filter((l) => l.kind === 'permalink').map((l) => l.url),
  };
}

/** False when there is nothing to send a model — skip the call entirely. */
export function hasUsableSignal(signals: SignalBundle): boolean {
  return Boolean(signals.userNote) || signals.titles.length > 0 || signals.media.length > 0;
}
