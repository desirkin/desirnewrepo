import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { walkBook } from '../lib/book-walk.js';
import { walkBook as descriptorWalk, roundTrip } from '../market-lab/recipes.js';

test('market descriptors re-export the exact same pure walk used by shadow research', () => {
  assert.equal(descriptorWalk, walkBook);
  const source = readFileSync(new URL('../lib/book-walk.js', import.meta.url), 'utf8');
  assert.ok(!/\bimport\b|\brequire\s*\(/.test(source), 'shared arithmetic imports no authority-bearing pipeline');
  const shadow = readFileSync(new URL('../learning/shadow-execution-evidence.js', import.meta.url), 'utf8');
  assert.ok(shadow.includes("from '../lib/book-walk.js'"));
  assert.ok(!shadow.includes('../market-lab'));
});

test('shared walk preserves full, partial, absent and zero-depth results without extrapolation', () => {
  const full = walkBook([[100, 1], [110, 2]], { quoteNotional: 155 });
  assert.deepEqual(full, {
    recipeId: 'book_walk', version: 1, requested: { quoteNotional: 155 },
    consumedLevels: 2, filledBase: 1.5, filledQuote: 155, residualQuote: 0,
    residualBase: null, averagePrice: 103.33333333, worstPrice: 110,
    coverage: 'FULL', hypothetical: true, preFee: true,
  });
  assert.ok(Object.isFrozen(full) && Object.isFrozen(full.requested));
  const partial = walkBook([[100, 0], [99, 1]], { baseQty: 2 });
  assert.equal(partial.coverage, 'PARTIAL');
  assert.equal(partial.filledQuote, 99);
  assert.equal(partial.residualBase, 1);
  assert.equal(walkBook([], { quoteNotional: 100 }).coverage, 'NO_BOOK');
  const trip = roundTrip({ asks: [[100, 2]], bids: [[99, 2]] }, 100);
  assert.equal(trip.coverage, 'FULL');
  assert.equal(trip.lossBps, 100);
  assert.equal(trip.saleProceeds, 99);
});
