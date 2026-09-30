import { logger } from '../lib/logger.js';
import { getSupabase, UNIQUE_VIOLATION } from '../lib/supabase.js';
import type { ParsedSave } from '../parse/index.js';
import type { NormalizedMessage } from './types.js';

/**
 * On conflict, only last_seen_at is touched — first_seen_at keeps its
 * original value (it's simply omitted from the update payload).
 */
export async function upsertSender(igsid: string): Promise<void> {
  const { error } = await getSupabase()
    .from('senders')
    .upsert({ igsid, last_seen_at: new Date().toISOString() }, { onConflict: 'igsid' });

  if (error) logger.error('failed to upsert sender', { igsid, error: error.message });
}

export type InsertMessageResult = { duplicate: true } | { duplicate: false; id: string };

/**
 * Inserted BEFORE parsing, not after: the `mid` unique constraint is the
 * durable dedupe guard (dedupe.ts's in-memory map is only a same-process fast
 * path). Landing this first means a retried delivery after a restart is
 * caught here instead of paying for a second Claude+Places round trip.
 */
export async function insertMessage(message: NormalizedMessage): Promise<InsertMessageResult> {
  const { data, error } = await getSupabase()
    .from('messages')
    .insert({
      mid: message.mid,
      sender_igsid: message.senderIgsid,
      recipient_igsid: message.recipientIgsid,
      sent_at: message.sentAt.toISOString(),
      text: message.text,
      attachments: message.attachments,
      links: message.links,
      is_story_reply: message.isStoryReply,
      raw: message.raw,
    })
    .select('id')
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { duplicate: true };
    throw error; // one bad message must not stop the batch; caller's try/catch handles this
  }

  return { duplicate: false, id: data.id as string };
}

export async function updateMessageFollowup(
  messageId: string,
  needsFollowup: boolean,
  reason?: string,
): Promise<void> {
  const { error } = await getSupabase()
    .from('messages')
    .update({ needs_followup: needsFollowup, followup_reason: reason ?? null })
    .eq('id', messageId);

  if (error) logger.error('failed to update message follow-up', { messageId, error: error.message });
}

/**
 * One row per PlaceCandidate, resolved or not — an unresolved candidate stays
 * visible ("we found a name but couldn't confirm an address") rather than
 * vanishing. candidate.placeName is typed nullable (Zod schema is shared with
 * the raw model output) but extractPlaces() already filters nulls out before
 * this is ever called; the filter below is a defensive backstop for the
 * `not null` column, not the primary guarantee.
 */
export async function insertSaves(
  messageId: string,
  senderIgsid: string,
  places: ParsedSave['places'],
): Promise<void> {
  const rows = places
    .filter(({ candidate }) => candidate.placeName !== null)
    .map(({ candidate, resolved }) => ({
      message_id: messageId,
      sender_igsid: senderIgsid,
      place_name: candidate.placeName as string,
      name_source: candidate.nameSource,
      category: candidate.category,
      cuisine: candidate.cuisine,
      evidence: candidate.evidence,
      resolved: resolved !== null,
      address: resolved?.address ?? null,
      place_id: resolved?.placeId ?? null,
      latitude: resolved?.latitude ?? null,
      longitude: resolved?.longitude ?? null,
    }));

  if (rows.length === 0) return;

  const { error } = await getSupabase().from('saves').insert(rows);
  if (error) logger.error('failed to insert saves', { messageId, error: error.message });
}
