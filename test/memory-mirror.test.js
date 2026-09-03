// MEMORY-0 §24 — DARK MIRROR acceptance. The sensors write their streams
// exactly as they always have; the mirror observes and remembers; NOTHING
// flows back. Existing outputs before memory == existing outputs after.
// Plus the architectural proof: no return path exists in the source graph.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA = mkdtempSync(path.join(tmpdir(), 'cobra-mirror-'));
process.env.COBRA_DATA_DIR = TEST_DATA;

const { startMemoryMirror } = await import('../memory/mirror.js');
const { sessionDate, nowIso } = await import('../lib/time.js');

test.after(() => rmSync(TEST_DATA, { recursive: true, force: true }));

const j = (o) => JSON.stringify(o) + '\n';
const under = (...p) => path.join(TEST_DATA, ...p);
const write = (rel, content) => {
  mkdirSync(path.dirname(under(...rel)), { recursive: true });
  writeFileSync(under(...rel), content);
};

test('DARK MIRROR: sensors unchanged byte-for-byte; memory receives canonical envelopes; no state transition occurs', () => {
  const ISO = nowIso();
  // ---- the world as the existing Serpent left it (sensor-owned files)
  write(['survey', 'events.jsonl'], j({ ts: ISO, type: 'WIDEEYE_STARTED', sweepSec: 60 }));
  write(['rumint', 'events.jsonl'], '');
  write(['gateway', 'transitions.jsonl'], '');
  write(['cost', 'evaluations.jsonl'], '');
  write(['state', 'transitions.jsonl'], '');
  write(['state', 'controls_log.jsonl'], '');
  write(['state', 'posture.json'], JSON.stringify({ posture: 'COILED', ts: ISO, cause: 'boot' }));
  write(['survey', 'nominations-current.json'], JSON.stringify({ date: sessionDate(), nominations: [] }));
  write(['tape', sessionDate(), 'snapshots.jsonl'], '');

  const mirror = startMemoryMirror({ log: () => {} });

  // ---- the ship flies: each EXISTING module writes its own stream exactly
  // as current logic does (nothing here calls memory; memory calls nothing)
  const sensorLines = {
    ['survey/events.jsonl']: j({ ts: ISO, type: 'RIPPLE', symbol: 'SOL', verdict: 'RIPPLE', zVol: 4.4, zRet: 2.7, extension: 1.2, liquidityNote: '$12.00M 24h', inDeepTape: true }),
    ['rumint/events.jsonl']: j({ ts: ISO, type: 'RUMINT_POLL', symbol: 'BTC', velocity: 9, z: 1.1 }),
    ['gateway/transitions.jsonl']: j({ observedAt: ISO, announcedAt: ISO, key: 'kraken:inc42', from: null, to: 'investigating', door: 'trading', title: 'Degraded matching' }),
    ['cost/evaluations.jsonl']: j({ ts: ISO, coin: 'BTC', side: 'buy', requestedSizeUsd: 100, ladder: false, bookRef: { ts: ISO, ageSec: 0.2 }, feeSchedule: { venue: 'kraken' }, rungs: [{ usd: 100, costBps: 9 }] }),
    ['state/transitions.jsonl']: j({ ts: ISO, from: 'COILED', to: 'STALKING', cause: 'S-2b nomination', demo: false }),
    [`tape/${sessionDate()}/snapshots.jsonl`]: j({ ts: ISO, coin: 'ETH', tapeState: 'CLEAN', mid: 3120.4, spreadBps: 0.6 }),
  };
  for (const [rel, line] of Object.entries(sensorLines)) appendFileSync(under(...rel.split('/')), line);

  // snapshot of every existing-module artifact BEFORE memory observes
  const artifactFiles = [
    ['survey', 'events.jsonl'],
    ['survey', 'nominations-current.json'],
    ['rumint', 'events.jsonl'],
    ['gateway', 'transitions.jsonl'],
    ['cost', 'evaluations.jsonl'],
    ['state', 'transitions.jsonl'],
    ['state', 'posture.json'],
    ['tape', sessionDate(), 'snapshots.jsonl'],
  ];
  const before = artifactFiles.map((f) => readFileSync(under(...f), 'utf8'));

  mirror.poll(); // the mirror looks — once, deterministically

  // ---- 1) EXISTING OUTPUTS BEFORE == AFTER: memory changed nothing
  const after = artifactFiles.map((f) => readFileSync(under(...f), 'utf8'));
  assert.deepEqual(after, before);
  assert.equal(JSON.parse(readFileSync(under('state', 'posture.json'), 'utf8')).posture, 'COILED'); // no posture change
  assert.deepEqual(JSON.parse(readFileSync(under('survey', 'nominations-current.json'), 'utf8')).nominations, []); // no nomination change

  // ---- 2) memory RECEIVED the observations, canonically
  const memLines = readFileSync(under('memory', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const byModule = Object.groupBy(memLines, (e) => e.sourceModule);
  assert.equal(byModule.WIDEEYE.length, 1); // pre-start WIDEEYE_STARTED line was history, not replayed
  assert.equal(byModule.WIDEEYE[0].eventType, 'WIDEEYE_RIPPLE');
  assert.equal(byModule.WIDEEYE[0].symbol, 'SOL');
  assert.equal(byModule.RUMINT[0].observationState, 'KNOWN');
  assert.equal(byModule.GATEWAY[0].correlation.eventId, 'kraken:inc42');
  assert.equal(byModule.TAPE[0].payload.mid, 3120.4);
  assert.equal(byModule.COST[0].evidenceFamily[0], 'EXECUTION_QUALITY');
  assert.equal(byModule.STATE[0].payload.to, 'STALKING'); // observed — not caused
  for (const e of memLines) assert.equal(e.schemaVersion, 'serpent-memory-1');

  // ---- 3) restart-and-repoll produces no duplicates (deterministic ids)
  mirror.poll();
  const again = readFileSync(under('memory', 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(again.length, memLines.length);

  // ---- 4) health is honest and the shutdown is clean
  const h = mirror.health();
  assert.equal(h.status, 'HEALTHY');
  assert.equal(h.acceptedCount, memLines.length);
  assert.equal(h.memoryVersion, 'MEMORY-0');
  mirror.stop();
  assert.ok(existsSync(under('memory', 'manifest.json'))); // flushed on close
  const manifest = JSON.parse(readFileSync(under('memory', 'manifest.json'), 'utf8'));
  assert.equal(manifest.recordCount, memLines.length);
});

test('TAPE SAMPLING: high-frequency snapshots are bounded, not duplicated wholesale', () => {
  const dir2 = mkdtempSync(path.join(tmpdir(), 'cobra-mirror2-'));
  process.env.COBRA_DATA_DIR = dir2;
  try {
    const mirror = startMemoryMirror({ log: () => {} });
    const file = path.join(dir2, 'tape', sessionDate(), 'snapshots.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
    const base = Date.now() - 60_000;
    let lines = '';
    for (let i = 0; i < 30; i++) {
      lines += j({ ts: new Date(base + i * 1000).toISOString(), coin: 'BTC', tapeState: 'CLEAN', mid: 100 + i });
    }
    writeFileSync(file, ''); // file appears...
    mirror.poll(); // ...tail anchors at its start
    appendFileSync(file, lines); // 30 snapshots inside one minute
    mirror.poll();
    const mem = readFileSync(path.join(dir2, 'memory', 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.equal(mem.length, 1); // one bounded MARKET_SNAPSHOT per coin per window
    mirror.stop();
  } finally {
    process.env.COBRA_DATA_DIR = TEST_DATA;
    rmSync(dir2, { recursive: true, force: true });
  }
});

// THE ARCHITECTURAL PROOF: no return path exists in the source graph.
test('NO RETURN PATH: only fly.js touches memory/, and memory/ imports no sensor or state machinery', () => {
  const root = path.join(import.meta.dirname, '..');
  const jsFiles = (dir) =>
    readdirSync(path.join(root, dir))
      .filter((f) => f.endsWith('.js'))
      .map((f) => path.join(dir, f));
  const sensorDirs = ['tape', 'survey', 'rumint', 'gateway', 'cost', 'state', 'ledger', 'ui', 'childhood', 'lib'];
  // 1) no sensor, state, ledger, UI or childhood module references memory
  for (const f of sensorDirs.flatMap(jsFiles)) {
    const src = readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/from\s+['"].*memory\//.test(src) && !/import\(.*memory\//.test(src), `${f} references memory/ — a return path`);
  }
  // 2) memory modules import ONLY lib helpers, node builtins, and each other
  for (const f of jsFiles('memory')) {
    const src = readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      const allowed = spec.startsWith('node:') || spec.startsWith('./') || /^\.\.\/lib\//.test(spec);
      assert.ok(allowed, `${f} imports ${spec} — memory must not reach into sensors, state, or execution`);
    }
    // and no dynamic escape hatches over evidence
    assert.ok(!/\beval\s*\(/.test(src) && !/new Function/.test(src), `${f} contains dynamic code execution`);
  }
  // 3) the composition root wires the mirror inside its own containment
  const fly = readFileSync(path.join(root, 'fly.js'), 'utf8');
  assert.ok(fly.includes("./memory/mirror.js"));
});
