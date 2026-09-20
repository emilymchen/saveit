# SaveIt — Instagram DM Ingestion Server

Receives Instagram DM webhooks from Meta, verifies them, and normalizes each
message into a single shape the rest of the pipeline consumes.

This is **Step 1** of the SaveIt pipeline:

```
user DMs a post  ->  [ Meta webhook ]  ->  THIS SERVER  ->  AI parsing  ->  place resolution  ->  Supabase  ->  iOS app
                                          ^^^^^^^^^^^
```

AI parsing, place resolution and persistence are not built yet. They plug in at
`handleMessage()` in [src/ingest/process.ts](src/ingest/process.ts).

## Setup

```bash
npm install
cp .env.example .env    # then fill in the two required values
```

Two secrets are required:

| Variable | Where it comes from |
| --- | --- |
| `IG_VERIFY_TOKEN` | You invent it. Generate with `openssl rand -hex 32`, then paste the same value into the Meta App Dashboard when subscribing the webhook. |
| `META_APP_SECRET` | Meta App Dashboard → App settings → Basic → App Secret. |

`IG_ACCESS_TOKEN` is only needed later, when the bot starts replying to users.

## Running

```bash
npm run dev        # watch mode on http://localhost:3000
npm run typecheck
npm run build && npm start
```

## Testing without Meta

`scripts/send-test-webhook.mjs` sends correctly-signed fake payloads at the local
server, so you can exercise the whole loop before any Meta wiring exists:

```bash
npm run webhook:test -- share            # a reshared post (the common real case)
npm run webhook:test -- text             # a pasted TikTok link with a user note
npm run webhook:test -- reel             # a shared reel
npm run webhook:test -- echo             # our own message reflected back; must be ignored
npm run webhook:test -- empty            # nothing extractable; must be skipped
npm run webhook:test -- share --bad-signature   # must be rejected with 403
```

Verified behavior as of the initial commit:

| Case | Result |
| --- | --- |
| GET handshake, correct token | `200`, challenge echoed as plain text |
| GET handshake, wrong token | `403` |
| Signed `share` / `text` / `reel` | `200`, normalized and logged |
| `is_echo` message | skipped (`reason: echo`) |
| Message with no text, link or attachment | skipped (`reason: empty`) |
| Forged signature | `403`, no processing |
| Same `mid` delivered twice | `200` both times, processed once |

## Connecting the real webhook

1. Your Instagram account must be a **Professional** account (Business or Creator)
   linked to a Facebook Page. Meta will not deliver DM events otherwise.
2. Expose the local server: `ngrok http 3000` → gives you an HTTPS URL.
3. In the Meta App Dashboard, add an Instagram webhook with:
   - Callback URL: `https://<your-ngrok-host>/webhook`
   - Verify Token: your `IG_VERIFY_TOKEN`
   - Subscribe to the **`messages`** field.
4. Saving the config triggers the GET handshake. The log should show
   `webhook verification succeeded`.
5. DM the bot account from a different Instagram account. While the app is in
   development mode, only users with a role on the app can trigger events —
   public access requires App Review for `instagram_manage_messages`.

With `PERSIST_RAW_EVENTS=true`, every payload is appended to
`data/raw-events.jsonl` (gitignored). Collect real shares there before designing
the AI parser — `share`, `ig_reel` and story replies all differ.

## Layout

```
src/
  index.ts              entry point, graceful shutdown
  app.ts                express wiring, raw-body capture
  config.ts             env validation; fails fast at boot
  routes/webhook.ts     GET handshake + signed POST receiver
  lib/signature.ts      X-Hub-Signature-256 HMAC verification
  lib/logger.ts         pretty in dev, JSON lines in prod
  ingest/
    types.ts            Meta envelope types + NormalizedMessage
    normalize.ts        envelope -> NormalizedMessage, with skip rules
    dedupe.ts           process-local mid guard against Meta retries
    rawEvents.ts        raw payload capture for parser design
    process.ts          async pipeline; where AI + DB plug in
scripts/
  send-test-webhook.mjs signed local payload generator
```

## Design notes

**The signature is computed over raw bytes.** `express.json`'s `verify` hook
stashes the untouched `Buffer` on `req.rawBody`. Re-serializing the parsed object
produces different bytes and the HMAC will never match — this is the single most
common way this integration breaks.

**Acknowledge first, work second.** Meta expects a response within seconds and
retries on timeout or non-2xx. The route returns `200` before any processing, so
slow AI calls can never cause a redelivery storm.

**Echoes must be dropped.** Once the bot replies to users, its own outbound
messages come back as webhook events with `is_echo: true`. Ingesting them makes
the bot respond to itself.

**Dedupe is currently process-local.** `dedupe.ts` is an in-memory TTL map; it
does not survive a restart or span instances. The durable guard is a `UNIQUE`
constraint on the message id in Postgres, added when persistence lands.

**IGSID is not a user id.** `senderIgsid` identifies an Instagram user *scoped to
this app*. It is not an email and does not map to a Supabase `auth.uid` without an
explicit account-linking flow. Saves will need to key on IGSID until a user links
their account.
