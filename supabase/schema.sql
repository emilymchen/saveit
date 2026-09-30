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
-- RLS is off by default: only the trusted backend touches most of this
-- database, via the service_role key (which bypasses RLS by design). It's
-- turned on below for the two tables the iOS app touches directly with a
-- user's own token (`saves`, `link_codes`) — everything else stays
-- service_role-only, unreachable without the secret key.

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

-- Short-lived proof-of-ownership codes: a signed-in user generates one in the
-- iOS app, DMs it to the bot, and the bot links that IGSID's sender row to
-- their account. Claimed via a single conditional UPDATE in linking.ts (not
-- select-then-update), so two concurrent deliveries of the same code can't
-- both succeed.
create table link_codes (
  code          text primary key,
  auth_user_id  uuid not null references auth.users(id),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz
);

alter table saves enable row level security;
create policy "own saves" on saves for select
  using (sender_igsid in (select igsid from senders where auth_user_id = auth.uid()));

alter table link_codes enable row level security;
create policy "own codes: insert" on link_codes for insert
  with check (auth_user_id = auth.uid());
create policy "own codes: read" on link_codes for select
  using (auth_user_id = auth.uid());
