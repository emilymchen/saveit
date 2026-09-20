import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import type { NormalizedMessage } from '../ingest/types.js';
import { extractPlaces, type PlaceCandidate } from './extract.js';
import { collectImages } from './media.js';
import { resolvePlace, type ResolvedPlace } from './resolve.js';
import { gatherSignals, hasUsableSignal, type SignalBundle } from './signals.js';

export type FollowupReason =
  | 'not-configured'
  | 'no-signal'
  | 'no-place-identified'
  | 'unresolved'
  /** Resolved, but the name was read off the video with no text to corroborate it. */
  | 'needs-confirmation';

export interface ParsedSave {
  places: Array<{ candidate: PlaceCandidate; resolved: ResolvedPlace | null }>;
  /** True when we cannot finish without asking the sender. */
  needsFollowup: boolean;
  reason?: FollowupReason;
  permalinks: string[];
}

function followup(reason: FollowupReason, permalinks: string[] = []): ParsedSave {
  return { places: [], needsFollowup: true, reason, permalinks };
}

/**
 * Signals -> images -> extraction -> address.
 *
 * Shared by the webhook path and the dev CLI, which is what lets the pipeline
 * be validated against real post files without a Meta app.
 */
export async function parseSignals(signals: SignalBundle): Promise<ParsedSave> {
  if (!config.ANTHROPIC_API_KEY) {
    logger.warn('parsing skipped: ANTHROPIC_API_KEY is not set');
    return followup('not-configured', signals.permalinks);
  }
  if (!hasUsableSignal(signals)) {
    return followup('no-signal', signals.permalinks);
  }

  const images = await collectImages(signals.media);
  const candidates = await extractPlaces(signals, images);

  if (candidates.length === 0) {
    return followup('no-place-identified', signals.permalinks);
  }

  const places: ParsedSave['places'] = [];
  for (const candidate of candidates) {
    places.push({ candidate, resolved: await resolvePlace(candidate) });
  }

  const resolved = places.filter((p) => p.resolved !== null);
  if (resolved.length === 0) {
    return { places, needsFollowup: true, reason: 'unresolved', permalinks: signals.permalinks };
  }

  /*
   * A name read off the pixels with no text backing it is the dangerous case:
   * signage routinely shows a vendor, sub-brand or dish rather than the venue,
   * and Places will happily resolve that to a real address somewhere else. The
   * name-match guard cannot catch it — it only checks Places against whatever
   * name we extracted, not whether that name was the right one. So confirm.
   */
  const unconfirmed = resolved.some((p) => p.candidate.nameSource === 'pixels');

  return {
    places,
    needsFollowup: unconfirmed,
    ...(unconfirmed ? { reason: 'needs-confirmation' as const } : {}),
    permalinks: signals.permalinks,
  };
}

export async function parseMessage(message: NormalizedMessage): Promise<ParsedSave> {
  const result = await parseSignals(gatherSignals(message));
  await persist(message.mid, result);
  return result;
}

/**
 * Until persistence lands, results go to a jsonl file so accuracy can be eyeballed.
 * Mirrors rawEvents.ts, including never letting a write failure break ingestion.
 */
async function persist(mid: string, result: ParsedSave): Promise<void> {
  if (!config.PERSIST_RAW_EVENTS) return;
  const file = path.resolve(process.cwd(), 'data', 'parsed-saves.jsonl');
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), mid, result })}\n`);
  } catch (err) {
    logger.error('parsed save log write failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
