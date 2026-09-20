#!/usr/bin/env node
/**
 * Sends a correctly-signed fake Instagram webhook at the local server, so the
 * ingestion loop can be exercised without Meta, ngrok, or a real DM.
 *
 * Usage:
 *   node --env-file=.env scripts/send-test-webhook.mjs [fixture]
 *
 * Fixtures: post (default) | post-bare | reel | link | echo | empty
 * Pass --bad-signature to confirm the endpoint rejects a forged request.
 */
import crypto from 'node:crypto';

const APP_SECRET = process.env.META_APP_SECRET;
const PORT = process.env.PORT ?? 3000;
const URL_TARGET = `http://localhost:${PORT}/webhook`;

if (!APP_SECRET) {
  console.error('META_APP_SECRET is not set. Run with: node --env-file=.env scripts/send-test-webhook.mjs');
  process.exit(1);
}

const SENDER = '17841400000000001';
const RECIPIENT = '17841400000000002';

const envelope = (message) => ({
  object: 'instagram',
  entry: [
    {
      id: RECIPIENT,
      time: Date.now(),
      messaging: [
        {
          sender: { id: SENDER },
          recipient: { id: RECIPIENT },
          timestamp: Date.now(),
          message,
        },
      ],
    },
  ],
});

/**
 * Shapes follow Meta's documented attachment payloads:
 * https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/messages/
 *
 *   ig_post   -> { url, title, id }
 *   ig_reel   -> { url, title, reel_video_id }
 *   fallback  -> { url, title }          (Meta unfurls a pasted link for us)
 *
 * `title` is documented but Meta never defines it as the caption, and the
 * Instagram-specific docs say only the URL is delivered. So each case has a
 * variant without it — we must work when it is absent.
 */
const FIXTURES = {
  // Reshared post, optimistic: media URL we can fetch, plus a title.
  post: envelope({
    mid: `mid.test.post.${Date.now()}`,
    attachments: [
      {
        type: 'ig_post',
        payload: {
          url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=17900000000000000',
          title: 'La Taqueria on Instagram: "the best burrito in SF, no rice, no debate"',
          id: '17900000000000000',
        },
      },
    ],
  }),
  // Reshared post, worst case: bare permalink, no title, no user note.
  // Nothing is extractable from this — it must cleanly report needsFollowup.
  'post-bare': envelope({
    mid: `mid.test.postbare.${Date.now()}`,
    attachments: [
      {
        type: 'ig_post',
        payload: { url: 'https://www.instagram.com/p/Cxyz123ABCD/', id: '17900000000000001' },
      },
    ],
  }),
  // Reshared reel: an expiring CDN mp4. The video itself is the primary signal.
  reel: envelope({
    mid: `mid.test.reel.${Date.now()}`,
    attachments: [
      {
        type: 'ig_reel',
        payload: {
          url: 'https://scontent.cdninstagram.com/v/t50.2886-16/fake_reel.mp4',
          title: 'best tacos in the mission',
          reel_video_id: '17900000000000002',
        },
      },
    ],
  }),
  // Pasted link with a note. Meta attaches a `fallback` carrying the unfurled title.
  link: envelope({
    mid: `mid.test.link.${Date.now()}`,
    text: 'omg need to try this matcha place https://www.tiktok.com/@someone/video/7300000000000000000',
    attachments: [
      {
        type: 'fallback',
        payload: {
          url: 'https://www.tiktok.com/@someone/video/7300000000000000000',
          title: 'Kettl Tea in the East Village is unreal | TikTok',
        },
      },
    ],
  }),
  // Our own outbound message reflected back. Must be ignored, or the bot loops.
  echo: envelope({
    mid: `mid.test.echo.${Date.now()}`,
    is_echo: true,
    text: 'Saved! I filed that under Restaurants.',
  }),
  // Nothing extractable — should be skipped as empty.
  empty: envelope({ mid: `mid.test.empty.${Date.now()}` }),
};

const args = process.argv.slice(2);
const badSignature = args.includes('--bad-signature');
const name = args.find((a) => !a.startsWith('--')) ?? 'post';

const fixture = FIXTURES[name];
if (!fixture) {
  console.error(`Unknown fixture "${name}". Options: ${Object.keys(FIXTURES).join(', ')}`);
  process.exit(1);
}

// Sign the exact bytes we are about to send, matching what Meta does.
const body = JSON.stringify(fixture);
const digest = crypto.createHmac('sha256', badSignature ? 'wrong-secret' : APP_SECRET)
  .update(body)
  .digest('hex');

const res = await fetch(URL_TARGET, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-hub-signature-256': `sha256=${digest}`,
  },
  body,
});

const label = `${name}${badSignature ? ' (forged signature)' : ''}`;
console.log(`${label} -> HTTP ${res.status} ${res.statusText}`);
console.log(badSignature && res.status === 403 ? 'Correctly rejected.' : '');
