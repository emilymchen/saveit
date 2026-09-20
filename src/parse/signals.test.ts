import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NormalizedMessage } from '../ingest/types.js';
import { gatherSignals, hasUsableSignal } from './signals.js';

function message(partial: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    mid: 'm1',
    senderIgsid: '1',
    recipientIgsid: '2',
    sentAt: new Date(0),
    text: null,
    attachments: [],
    links: [],
    isStoryReply: false,
    raw: {},
    ...partial,
  };
}

test('splits media from permalinks and collects titles', () => {
  const signals = gatherSignals(
    message({
      text: 'need to try this',
      attachments: [{ type: 'ig_reel', payload: { title: 'best tacos in the mission' } }],
      links: [
        { url: 'https://scontent.cdninstagram.com/r.mp4', platform: 'instagram', source: 'attachment', kind: 'media' },
        { url: 'https://www.instagram.com/p/Cxyz/', platform: 'instagram', source: 'text', kind: 'permalink' },
      ],
    }),
  );

  assert.equal(signals.userNote, 'need to try this');
  assert.deepEqual(signals.titles, ['best tacos in the mission']);
  assert.deepEqual(signals.media, ['https://scontent.cdninstagram.com/r.mp4']);
  assert.deepEqual(signals.permalinks, ['https://www.instagram.com/p/Cxyz/']);
});

test('drops absent and blank titles', () => {
  const signals = gatherSignals(
    message({
      attachments: [
        { type: 'ig_post', payload: { url: 'https://x.test/a' } },
        { type: 'ig_post', payload: { title: '   ' } },
      ],
    }),
  );
  assert.deepEqual(signals.titles, []);
});

test('a bare permalink with no note is not a usable signal', () => {
  const signals = gatherSignals(
    message({
      links: [
        { url: 'https://www.instagram.com/p/Cxyz/', platform: 'instagram', source: 'attachment', kind: 'permalink' },
      ],
    }),
  );
  assert.equal(hasUsableSignal(signals), false);
});

test('media alone is a usable signal', () => {
  const signals = gatherSignals(
    message({
      links: [
        { url: 'https://scontent.cdninstagram.com/r.mp4', platform: 'instagram', source: 'attachment', kind: 'media' },
      ],
    }),
  );
  assert.equal(hasUsableSignal(signals), true);
});
