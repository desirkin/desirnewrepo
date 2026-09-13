import test from 'node:test';
import assert from 'node:assert/strict';
import { bookSnapshotError, digestOf } from '../execution/contract.js';

const T = Date.UTC(2026, 8, 13, 12);

function snapshot({ bids, asks }) {
  const value = {
    snapshotVersion: 'execution-book-snapshot-1',
    symbol: 'XBT/USD',
    canonicalCoin: 'BTC',
    feedEpoch: 1,
    receiptSequence: 1,
    nativeSequence: null,
    sourceTs: T,
    receiptTs: T,
    crc: null,
    crcVerified: null,
    crcComputed: null,
    synced: true,
    instrumentDigest: null,
    priceDecimals: null,
    qtyDecimals: null,
    bids,
    asks,
    levelsCap: 200,
    truncated: false,
    kind: 'SNAPSHOT',
    digest: 'x'.repeat(64),
  };
  value.digest = digestOf({ ...value, digest: null });
  return value;
}

test('bid ordering uses exact decimal value, never lexical OR floating-point order', () => {
  const lexicalTrap = snapshot({
    bids: [['99', '1'], ['100', '1']],
    asks: [['101', '1']],
  });
  assert.equal(bookSnapshotError(lexicalTrap), 'bookSnapshot: bids not descending');

  const valid = snapshot({
    bids: [['100', '1'], ['99.999999999999999999', '1'], ['9', '1']],
    asks: [['100.000000000000000001', '1']],
  });
  assert.equal(bookSnapshotError(valid), null);
});

test('duplicate prices are refused on both sides', () => {
  assert.equal(bookSnapshotError(snapshot({
    bids: [['100', '1'], ['100', '2']],
    asks: [['101', '1']],
  })), 'bookSnapshot: bids not descending');

  assert.equal(bookSnapshotError(snapshot({
    bids: [['99', '1']],
    asks: [['100', '1'], ['100', '2']],
  })), 'bookSnapshot: asks not ascending');
});

test('malformed ask ordering is refused with exact decimal comparison', () => {
  assert.equal(bookSnapshotError(snapshot({
    bids: [['98', '1']],
    asks: [['100', '1'], ['99', '1']],
  })), 'bookSnapshot: asks not ascending');

  assert.equal(bookSnapshotError(snapshot({
    bids: [['9', '1']],
    asks: [['9.999999999999999999', '1'], ['10', '1']],
  })), null);
});

test('crossing is exact across decimal scales beyond IEEE-754 precision', () => {
  const narrowButValid = snapshot({
    bids: [['9.999999999999999999', '1']],
    asks: [['10', '1']],
  });
  assert.equal(bookSnapshotError(narrowButValid), null, 'distinct exact prices must not collapse to Number(10)');

  const largeButValid = snapshot({
    bids: [['9007199254740992', '1']],
    asks: [['9007199254740993', '1']],
  });
  assert.equal(bookSnapshotError(largeButValid), null, 'distinct integers beyond Number safe precision remain ordered');

  assert.equal(bookSnapshotError(snapshot({
    bids: [['10', '1']],
    asks: [['9.999999999999999999', '1']],
  })), 'bookSnapshot: crossed');

  assert.equal(bookSnapshotError(snapshot({
    bids: [['100', '1']],
    asks: [['100', '1']],
  })), 'bookSnapshot: crossed');
});
