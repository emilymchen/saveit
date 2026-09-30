-- SaveIt persistence schema.
--
-- Applied by pasting into the Supabase SQL editor (no CLI/migrations tooling
-- yet — not worth adding for a single schema push at this stage). Field names
-- match the real types in the code, not invented vocabulary:
--   PlaceCandidate   -> src/parse/extract.ts
--   ResolvedPlace    -> src/parse/resolve.ts
--   NormalizedMessage -> src/ingest/types.ts
--   ParsedSave / FollowupReason -> src/parse/index.ts
--
-- RLS is deliberately left off: only the trusted backend touches this
-- database, via the service_role key (which bypasses RLS by design). RLS
-- policies become relevant once a client (the future iOS app, or this web
-- view if it gets real per-user auth) talks to Supabase directly with a
-- user's own token.

-- One row per Instagram account that has ever DM'd the bot. auth_user_id
-- stays null until an account-linking flow exists.
create table senders (
  igsid           text primary key,
  auth_user_id    uuid references auth.users(id),
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now()
);

-- One row per inbound DM. The `mid` unique constraint is the durable dedupe
-- guard dedupe.ts's own docstring already calls for: the in-memory TTL map
-- stays as a fast path within one process lifetime, this is the backstop
-- that survives a restart/redeploy.
create table messages (
  id               uuid primary key default gen_random_uuid(),
  mid              text unique not null,
  sender_igsid     text not null references senders(igsid),
  recipient_igsid  text not null,
  sent_at          timestamptz not null,
  received_at      timestamptz not null default now(),
  text             text,
  attachments      jsonb not null default '[]',
  links            jsonb not null default '[]',
  is_story_reply   boolean not null default false,
  raw              jsonb not null,
  needs_followup   boolean not null default false,
  followup_reason  text
);

-- One row per PlaceCandidate the parser returned for a message (0+ rows).
-- Present even when unresolved, so "we found a name but couldn't confirm an
-- address" stays visible instead of being silently dropped.
create table saves (
  id              uuid primary key default gen_random_uuid(),
  message_id      uuid not null references messages(id),
  sender_igsid    text not null references senders(igsid),
  place_name      text not null,
  name_source     text not null,
  category        text,
  cuisine         text,
  evidence        text not null,
  resolved        boolean not null default false,
  address         text,
  place_id        text,
  latitude        double precision,
  longitude       double precision,
  created_at      timestamptz not null default now()
);

create index on messages (sender_igsid);
create index on saves (sender_igsid);
create index on saves (created_at desc);
