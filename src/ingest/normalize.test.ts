import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeEvent } from './normalize.js';
import type { IgMessagingEvent } from './types.js';

function event(message: IgMessagingEvent['message']): IgMessagingEvent {
  return {
    sender: { id: '1' },
    recipient: { id: '2' },
    timestamp: 1700000000000,
    message,
  };
}

function linksFor(message: IgMessagingEvent['message']) {
  const result = normalizeEvent(event(message));
  assert.ok(result.ok, 'expected the event to normalize');
  return result.message.links;
}

test('classifies instagram and tiktok permalinks', () => {
  const links = linksFor({
    mid: 'm1',
    text: 'https://www.instagram.com/p/Cxyz123/ and https://www.tiktok.com/@a/video/7300000000000000000',
  });

  assert.equal(links.length, 2);
  assert.deepEqual(
    links.map((l) => [l.platform, l.kind]),
    [
      ['instagram', 'permalink'],
      ['tiktok', 'permalink'],
    ],
  );
});

test('classifies CDN hosts as fetchable media', () => {
  const links = linksFor({
    mid: 'm2',
    attachments: [
      { type: 'ig_reel', payload: { url: 'https://scontent.cdninstagram.com/v/t50/r.mp4' } },
      { type: 'ig_post', payload: { url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1' } },
    ],
  });

  assert.deepEqual(
    links.map((l) => l.kind),
    ['media', 'media'],
  );
});

test('an instagram profile url is neither media nor a post permalink', () => {
  const [link] = linksFor({ mid: 'm3', text: 'https://www.instagram.com/someplace/' });
  assert.equal(link?.platform, 'instagram');
  assert.equal(link?.kind, 'other');
});

test('a lookalike domain is not matched as tiktok', () => {
  const [link] = linksFor({ mid: 'm4', text: 'https://nottiktok.com/@a/video/123' });
  assert.equal(link?.platform, 'other');
  assert.equal(link?.kind, 'other');
});

test('skips an echo before looking at anything else', () => {
  const result = normalizeEvent(event({ mid: 'm5', is_echo: true, text: 'Saved!' }));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'echo');
});

test('skips a message with nothing extractable', () => {
  const result = normalizeEvent(event({ mid: 'm6' }));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'empty');
});
