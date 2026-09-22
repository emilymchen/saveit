# SaveIt — Instagram DM Ingestion Server

Receives Instagram DM webhooks from Meta, verifies them, and normalizes each
message into a single shape the rest of the pipeline consumes.

```
user DMs a post  ->  [ Meta webhook ]  ->  THIS SERVER  ->  Supabase  ->  iOS app
                                          ^^^^^^^^^^^^
                                   ingest + AI parsing + place resolution
```

Ingestion, parsing and place resolution are built. Persistence and the
confirmation DM back to the sender are not — they plug in at `handleMessage()`
in [src/ingest/process.ts](src/ingest/process.ts).

**The video is the signal.** Meta delivers no caption: the attachment `title`
field is documented but undefined as a caption, and the Instagram-specific docs
say [only a URL is
delivered](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api).
So the place name is read off the pixels — storefront signage, text overlays,
the name card at the end of a reel. Text is opportunistic enrichment.

The model is never asked for a street address; it returns a name and location
hints, and Google Places resolves those to a verified address. A hallucinated
address is the worst failure this product can have.

## Setup

```bash
npm install
cp .env.example .env    # then fill in the two required values
```

Two secrets are required:

| Variable | Where it comes from |
| --- | --- |
| `IG_VERIFY_TOKEN` | You invent it. Generate with `openssl rand -hex 32`, then paste the same value into the Meta App Dashboard when subscribing the webhook. |
| `META_APP_SECRET` | **Depends on the Instagram product.** Standalone Instagram API with Instagram Login (no linked Facebook Page): App Dashboard → Use cases → Instagram API → "Instagram app secret" — a *different* value from the one below. Instagram via Facebook Login: App Dashboard → App settings → Basic → App Secret. See [Design notes](#design-notes). |

Parsing needs two more. Both are optional — without them the server still
ingests and logs DMs, and parsing skips itself:

| Variable | Where it comes from |
| --- | --- |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys |
| `GOOGLE_MAPS_API_KEY` | Google Cloud console, with **Places API (New)** enabled. |

Video frame extraction needs `ffmpeg` on the PATH (`brew install ffmpeg`).
Without it, images still work and videos are skipped.

`IG_ACCESS_TOKEN` is only needed later, when the bot starts replying to users.

## Running

```bash
npm run dev        # watch mode on http://localhost:3000
npm run typecheck
npm test
npm run build && npm start
```

## Parsing a post without Meta

The fastest loop for tuning the parser. Download a real reel or post, point the
CLI at the file, and see what comes back — no Meta app, no tunnel, no webhook:

```bash
npm run parse -- ./fixtures/tacos.mp4
npm run parse -- ./fixtures/tacos.mp4 --note "need to try this"
npm run parse -- ./fixtures/tacos.mp4 --dry-run   # print the request, spend nothing
```

A sidecar `tacos.mp4.json` of `{ "title": "...", "note": "..." }` is picked up
automatically, so a fixture can carry its real caption alongside it.

A bare Instagram URL will not work here — Instagram login-walls non-browser
clients, which is the same reason we cannot fetch captions. Download the file.

## Testing without Meta

`scripts/send-test-webhook.mjs` sends correctly-signed fake payloads at the local
server, so you can exercise the whole loop before any Meta wiring exists:

Fixture shapes follow [Meta's documented attachment
payloads](https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/messages/):
`ig_post` carries `{url, title, id}`, `ig_reel` carries `{url, title,
reel_video_id}`, and a pasted link arrives as `fallback` with `{url, title}`.
Note there is no `share` attachment type, despite it being an obvious guess.

```bash
npm run webhook:test -- post             # reshared post: media url + title
npm run webhook:test -- post-bare        # reshared post: bare permalink, no title
npm run webhook:test -- reel             # reshared reel
npm run webhook:test -- link             # pasted TikTok link with a user note
npm run webhook:test -- echo             # our own message reflected back; must be ignored
npm run webhook:test -- empty            # nothing extractable; must be skipped
npm run webhook:test -- post --bad-signature    # must be rejected with 403
```

`post-bare` is the genuinely unresolvable case: no title, a permalink we cannot
read, and no note from the sender. It must report `needsFollowup` cleanly rather
than inventing something.

Verified behavior as of the initial commit:

| Case | Result |
| --- | --- |
| GET handshake, correct token | `200`, challenge echoed as plain text |
| GET handshake, wrong token | `403` |
| Signed `post` / `reel` / `link` | `200`, normalized and logged |
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
    process.ts          async pipeline; where the DB plugs in
  parse/
    signals.ts          NormalizedMessage -> SignalBundle
    media.ts            fetch + ffmpeg frames, behind a host allowlist
    extract.ts          one Claude call -> place name + location hints
    resolve.ts          Google Places -> verified address, name-match guarded
    index.ts            orchestration; entered from handleMessage()
scripts/
  send-test-webhook.mjs signed local payload generator
  parse-file.ts         run the parser against a local post file
  inspect-events.mjs    pretty-print captured raw payloads
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

**We do not scrape Instagram for captions.** Fetching `og:description` off a
permalink would often yield a truncated caption, and was considered and
rejected: it breaches Instagram's ToS, gets login-walled from datacenter IPs,
and needs crawler user-agent spoofing to work reliably. Reading the video frames
is both legitimate and more accurate. `instagram_oembed` is not an alternative —
it returns only `html`, `provider_name`, `provider_url`, `type`, `version` and
`width`.

**Media fetches use a host allowlist, not a blocklist.** The URLs in
`media.ts` arrive inside an external webhook payload, so anything other than a
known Meta or TikTok CDN host is refused outright — otherwise the server
becomes a request-forgery primitive aimed at whatever is reachable from it.

**Places is asked to confirm, not to search.** Text Search answers almost any
query with something confident-looking, so a miss is indistinguishable from a
hit. `resolve.ts` requires the returned name to share at least half its words
with the extracted name. Saving a real address for the wrong restaurant is the
one failure a user would never think to double-check.

**IGSID is not a user id.** `senderIgsid` identifies an Instagram user *scoped to
this app*. It is not an email and does not map to a Supabase `auth.uid` without an
explicit account-linking flow. Saves will need to key on IGSID until a user links
their account.

**The standalone Instagram API signs with a different secret than Basic
Settings.** An app set up via Use cases → Instagram API (Instagram Login, no
Facebook Page) has *two* app secrets: the classic one on App settings → Basic,
and a separate "Instagram app secret" on the Instagram API use case page. Meta
signs Instagram DM webhook deliveries with the latter. Using the former passes
every sanity check — same App ID, secret copies character-for-character,
request body parses as valid JSON — and still produces a signature that never
matches, because HMAC is correct on both ends but keyed differently. Confirmed
by replaying a captured real payload through the signature check with each
secret; only the Instagram-specific one produces a match.

**Two different webhook envelopes carry the same event.** Instagram via
Facebook Login delivers DMs as `entry[].messaging[]` (Messenger Platform
style). The standalone Instagram API (Instagram Login) delivers the identical
event data wrapped in the older, generic Graph API envelope instead:
`entry[].changes[]` with `field: "messages"` and the event under `.value`. Same
inner shape (`sender`, `recipient`, `message.text`, …), different wrapper, and
which one arrives is dictated entirely by which product the app uses — not
something we chose. `extractEvents()` in `normalize.ts` flattens both. The
`changes` envelope also sends `timestamp` as a numeric *string* in epoch
*seconds*, versus a `number` in epoch milliseconds on the `messaging` envelope;
`parseEventTimestamp()` normalizes both.
