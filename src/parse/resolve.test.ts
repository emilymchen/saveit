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

test('matches across spacing and punctuation differences', () => {
  // Real case: caption said "Sour Aji", Places listed it as "SourAji" at the
  // exact address the caption gave, and token overlap scored it zero.
  assert.ok(namesMatch('Sour Aji', 'SourAji'));
  assert.ok(namesMatch('SourAji', 'Sour Aji'));
  assert.ok(namesMatch("Jacob's Pickles", 'Jacobs Pickles'));
});

test('does not let the spacing rule collapse distinct names', () => {
  // Squashed comparison is equality-only; containment would match these.
  assert.equal(namesMatch('Bar', 'Barcelona'), false);
  assert.equal(namesMatch('Layln', 'LALYN'), false);
});

test('rejects empty input rather than treating it as a match', () => {
  assert.equal(namesMatch('', 'Tartine'), false);
  assert.equal(namesMatch('Tartine', ''), false);
  assert.equal(namesMatch('!!!', 'Tartine'), false);
});
