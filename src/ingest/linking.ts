import { logger } from '../lib/logger.js';
import { getSupabase } from '../lib/supabase.js';
import { upsertSender } from './persist.js';
import type { NormalizedMessage } from './types.js';

/**
 * A link code is a command, not a place to save: "DM this code to link your
 * account" from the iOS app. Checked before parsing so a code never reaches
 * Claude/Places — both cost and correctness matter here.
 *
 * Claiming the code is a single conditional UPDATE (code matches, not yet
 * used, not expired) rather than a SELECT-then-UPDATE, so two concurrent
 * deliveries of the same code (a Meta retry, say) can't both succeed — only
 * one UPDATE can match the still-unused row.
 */
export async function tryHandleLinkCode(message: NormalizedMessage): Promise<boolean> {
  const code = message.text?.trim().toUpperCase();
  if (!code) return false;

  const { data, error } = await getSupabase()
    .from('link_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('code', code)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('auth_user_id')
    .maybeSingle();

  if (error) {
    logger.error('failed to check link code', { error: error.message });
    return false;
  }
  if (!data) return false; // not a link code (or already used/expired) — fall through to normal parsing

  await upsertSender(message.senderIgsid);

  const { error: linkError } = await getSupabase()
    .from('senders')
    .update({ auth_user_id: data.auth_user_id })
    .eq('igsid', message.senderIgsid);

  if (linkError) {
    logger.error('failed to link sender to account', {
      igsid: message.senderIgsid,
      error: linkError.message,
    });
    return true; // still a link-code message either way — don't fall through to parsing
  }

  logger.info('linked sender to account', { igsid: message.senderIgsid, authUserId: data.auth_user_id });
  return true;
}
