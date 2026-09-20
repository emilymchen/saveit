#!/usr/bin/env node
/**
 * Sends a correctly-signed fake Instagram webhook at the local server, so the
 * ingestion loop can be exercised without Meta, ngrok, or a real DM.
 *
 * Usage:
 *   node --env-file=.env scripts/send-test-webhook.mjs [fixture]
 *
 * Fixtures: share (default) | text | reel | echo | empty
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

const FIXTURES = {
  // A reshared post: the common real case. Note there is no caption field.
  share: envelope({
    mid: `mid.test.share.${Date.now()}`,
    attachments: [
      {
        type: 'share',
        payload: { url: 'https://www.instagram.com/p/Cxyz123ABCD/' },
      },
    ],
  }),
  // A pasted link with a note from the user — the note is often our best signal.
  text: envelope({
    mid: `mid.test.text.${Date.now()}`,
    text: 'omg need to try this matcha place https://www.tiktok.com/@someone/video/7300000000000000000',
  }),
  reel: envelope({
    mid: `mid.test.reel.${Date.now()}`,
    attachments: [
      {
        type: 'ig_reel',
        payload: {
          url: 'https://scontent.cdninstagram.com/v/t50.2886-16/fake_reel.mp4',
          title: 'best tacos in the mission',
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
const name = args.find((a) => !a.startsWith('--')) ?? 'share';

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
