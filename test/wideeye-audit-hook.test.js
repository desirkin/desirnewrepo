import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'serpent-audit-hook-'));
process.env.COBRA_DATA_DIR = root;
process.env.WIDEEYE_ENABLED = 'true';
const { startWideEye } = await import('../survey/wideeye.js');
const { loadConfig } = await import('../lib/config.js');
test.after(() => { delete process.env.WIDEEYE_ENABLED; rmSync(root, { recursive: true, force: true }); });

const pairs = Object.fromEntries(['AAA', 'BBB', 'CCC'].map((coin) => [`${coin}USD`, { base: coin, quote: 'USD', wsname: `${coin}/USD`, altname: `${coin}USD`, status: 'online' }]));
function harness(opportunityAudit) {
  const calls = []; let now = Date.UTC(2026, 8, 13, 12);
  const eye = startWideEye({ config: loadConfig(), log() {}, now: () => now,
    registerSignals: false, nominationEnabled: false, deepCoinsSource: () => new Set(), opportunityAudit,
    setIntervalImpl: () => ({ refresh() {} }), clearIntervalImpl() {}, setTimeoutImpl: () => 1, clearTimeoutImpl() {},
    fetchImpl: async (url) => { calls.push(url.includes('AssetPairs') ? 'CATALOG' : 'TICKER'); return { ok: true, json: async () => ({ error: [], result: url.includes('AssetPairs') ? pairs : { AAAUSD: { c: ['10'], v: ['1','1'], p: ['10','10'] }, BBBUSD: { c: ['bad'], v: ['1','1'], p: ['1','1'] } } }) }; },
  });
  return { eye, calls, advance() { now += 60000; } };
}

test('audit frame is durable before Ticker, and every excluded identity is retained for follow-up', async () => {
  let h; let observed; let frames = 0;
  const port = {
    async beforeSweep(input) {
      assert.deepEqual(Object.keys(input).sort(), ['catalogSnapshot','frameTs']);
      assert.equal(h.calls.at(-1), frames ? 'TICKER' : 'CATALOG');
      assert.equal(input.catalogSnapshot.catalog.markets.length, 3);
      h.calls.push('FRAME_COMMITTED'); frames++;
      return { frame: frames };
    },
    async afterSweep({ auditToken, observation }) { assert.ok(auditToken.frame > 0); assert.equal(h.calls.at(-1), 'TICKER'); observed = observation; },
  };
  h = harness(port);
  try {
    await h.eye._sweepOnce();
    assert.deepEqual(h.calls, ['CATALOG','FRAME_COMMITTED','TICKER']);
    assert.equal(observed.rows.length, 3);
    const reasons = Object.fromEntries(observed.rows.map((r) => [r.coin, r.reason]));
    assert.deepEqual(reasons, { AAA:'INSUFFICIENT_SERIES', BBB:'PRICE_INVALID', CCC:'NO_TICKER_ROW' });
    h.advance(); await h.eye._sweepOnce();
    assert.equal(observed.rows.find((r) => r.coin === 'AAA').evaluated, true);
    assert.equal(h.eye.opportunityAuditStatus().error, null);
  } finally { h.eye.stop(); }
});

test('failed or stuck audit latches off without preventing sensor sweeps or creating false annotations', async () => {
  for (const stuck of [false, true]) {
    let before = 0; let after = 0;
    const h = harness({ beforeSweep() { before++; if (stuck) return new Promise(() => {}); throw new Error('DISK_FULL'); }, afterSweep() { after++; } });
    try {
      await h.eye._sweepOnce(); h.advance(); await h.eye._sweepOnce();
      assert.equal(before, 1); assert.equal(after, 0);
      assert.equal(h.calls.filter((c) => c === 'TICKER').length, 2);
      assert.equal(h.eye.opportunityAuditStatus().disabled, true);
      assert.match(h.eye.opportunityAuditStatus().error, stuck ? /WAIT_BUDGET/ : /DISK_FULL/);
    } finally { h.eye.stop(); }
  }
});
