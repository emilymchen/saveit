import assert from 'node:assert/strict';
import { test } from 'node:test';
import { namesMatch } from './resolve.js';

/**
 * The guard exists because Text Search answers almost any query with something
 * confident-looking. Saving a real address for the wrong restaurant is the one
 * failure a user would never think to double-check.
 */

test('accepts exact and near-exact names', () => {
  assert.ok(namesMatch('Tartine Bakery', 'Tartine Bakery'));
  assert.ok(namesMatch('tartine bakery', 'Tartine Bakery & Cafe'));
  assert.ok(namesMatch('La Taqueria', 'La Taquería'));
});

test('accepts a name that picks up extra words from Places', () => {
  assert.ok(namesMatch('Kettl', 'Kettl Tea'));
});

test('rejects an unrelated result', () => {
  assert.equal(namesMatch('Tartine Bakery', 'Blue Bottle Coffee'), false);
});

test('rejects a result sharing only one word of several', () => {
  assert.equal(namesMatch('Golden Gate Bakery Company', 'Golden Corral'), false);
});

test('rejects empty input rather than treating it as a match', () => {
  assert.equal(namesMatch('', 'Tartine'), false);
  assert.equal(namesMatch('Tartine', ''), false);
  assert.equal(namesMatch('!!!', 'Tartine'), false);
});
