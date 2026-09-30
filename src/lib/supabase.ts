import { createClient, type SupabaseClient, type WebSocketLikeConstructor } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { config } from '../config.js';

/**
 * Connects with the service_role key: this is a trusted backend context, not
 * a browser, so it intentionally bypasses Row Level Security. RLS policies
 * become relevant once a client (the future iOS app, or the internal viewer
 * if it ever gets real per-user auth) talks to Supabase directly with a
 * user's own token.
 *
 * We only use REST reads/writes here — no realtime subscriptions — but
 * createClient() eagerly constructs a realtime client regardless, which
 * probes for native WebSocket support at construction time. That's present
 * on Node 22+ but not Node 20 (this repo's minimum supported version), so it
 * throws immediately without an explicit transport. `ws` makes this work
 * across the whole supported Node range instead of requiring an upgrade.
 */
let client: SupabaseClient | undefined;

export function getSupabase(): SupabaseClient {
  client ??= createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    realtime: { transport: WebSocket as unknown as WebSocketLikeConstructor },
  });
  return client;
}

/** Postgres/PostgREST unique-violation code — how a duplicate `mid` insert reports itself. */
export const UNIQUE_VIOLATION = '23505';
