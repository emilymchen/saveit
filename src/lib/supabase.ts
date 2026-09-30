import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';

/**
 * Connects with the service_role key: this is a trusted backend context, not
 * a browser, so it intentionally bypasses Row Level Security. RLS policies
 * become relevant once a client (the future iOS app, or the internal viewer
 * if it ever gets real per-user auth) talks to Supabase directly with a
 * user's own token.
 */
let client: SupabaseClient | undefined;

export function getSupabase(): SupabaseClient {
  client ??= createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
  return client;
}

/** Postgres/PostgREST unique-violation code — how a duplicate `mid` insert reports itself. */
export const UNIQUE_VIOLATION = '23505';
