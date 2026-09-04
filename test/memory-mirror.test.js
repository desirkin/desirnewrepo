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

// MEMORY-0A §8 — the startup capture boundary: pre-existing history is not
// replayed; records written after the mirror opens (sensor STARTED lines
// included) are captured; sensor files stay untouched.
test('STARTUP BOUNDARY: pre-existing records skipped, post-open startup records captured', () => {
  const d3 = mkdtempSync(path.join(tmpdir(), 'cobra-mirror3-'));
  process.env.COBRA_DATA_DIR = d3;
  try {
    const oldIso = new Date(Date.now() - 3600_000).toISOString();
    const file = path.join(d3, 'rumint', 'events.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, j({ ts: oldIso, type: 'RUMINT_STARTED', budget: 60 })); // yesterday's boot
    const mirror = startMemoryMirror({ log: () => {} });
    appendFileSync(file, j({ ts: nowIso(), type: 'RUMINT_STARTED', budget: 60 })); // THIS boot, after mirror opened
    const sensorBytes = readFileSync(file, 'utf8');
    mirror.poll();
    const mem = readFileSync(path.join(d3, 'memory', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(mem.length, 1); // the new startup record — not the historical one
    assert.equal(mem[0].sourceModule, 'RUMINT');
    assert.ok(Math.abs(mem[0].ts * 1000 - Date.now()) < 60_000);
    assert.equal(readFileSync(file, 'utf8'), sensorBytes); // sensor file untouched by the mirror
    mirror.stop();
  } finally {
    process.env.COBRA_DATA_DIR = TEST_DATA;
    rmSync(d3, { recursive: true, force: true });
  }
});

// MEMORY-0A §9 — daily tape rollover: a session file born after the mirror
// opened is NEW live evidence and is read from byte zero.
test('DAILY ROLLOVER: the new day tape file starts at byte zero; the old day is not replayed', () => {
  const d4 = mkdtempSync(path.join(tmpdir(), 'cobra-mirror4-'));
  process.env.COBRA_DATA_DIR = d4;
  try {
    let day = 'day1';
    const ISO = nowIso();
    const day1File = path.join(d4, 'tape', 'day1', 'snapshots.jsonl');
    mkdirSync(path.dirname(day1File), { recursive: true });
    writeFileSync(day1File, j({ ts: ISO, coin: 'BTC', tapeState: 'LIVE', mid: 1 })); // history before mirror open
    const mirror = startMemoryMirror({ log: () => {}, sessionDateOf: () => day });
    mirror.poll();
    assert.ok(!existsSync(path.join(d4, 'memory', 'events.jsonl'))); // day1 history anchored at EOF, not replayed
    // the date rolls; tape writes into the NEW session file before the next poll
    day = 'day2';
    const day2File = path.join(d4, 'tape', 'day2', 'snapshots.jsonl');
    mkdirSync(path.dirname(day2File), { recursive: true });
    writeFileSync(day2File, j({ ts: nowIso(), coin: 'BTC', tapeState: 'LIVE', mid: 2 }) + j({ ts: nowIso(), coin: 'ETH', tapeState: 'LIVE', mid: 3 }));
    mirror.poll();
    const mem = readFileSync(path.join(d4, 'memory', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(mem.length, 2); // BOTH first records of the new day captured from byte zero
    assert.deepEqual(mem.map((e) => e.payload.mid).sort(), [2, 3]);
    mirror.stop();
  } finally {
    process.env.COBRA_DATA_DIR = TEST_DATA;
    rmSync(d4, { recursive: true, force: true });
  }
});

// MEMORY-0A §10 — ingestion loss is counted and degrades health; sensor
// files are never rewritten.
test('SOURCE INGESTION HONESTY: a malformed sensor line degrades memory health and touches nothing else', () => {
  const d5 = mkdtempSync(path.join(tmpdir(), 'cobra-mirror5-'));
  process.env.COBRA_DATA_DIR = d5;
  try {
    const file = path.join(d5, 'survey', 'events.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
    const mirror = startMemoryMirror({ log: () => {} });
    appendFileSync(file, '{this is not json}\n' + j({ ts: nowIso(), type: 'RIPPLE', symbol: 'BTC', verdict: 'RIPPLE', zVol: 4, zRet: 2.2, extension: 1 }));
    const sensorBytes = readFileSync(file, 'utf8');
    mirror.poll();
    const h = mirror.health();
    assert.equal(h.status, 'DEGRADED'); // ingestion loss is never pretended away
    assert.equal(h.sourceParseErrors, 1);
    assert.equal(h.adapterErrors, 0);
    assert.equal(h.acceptedCount, 1); // the good line still flowed
    assert.equal(readFileSync(file, 'utf8'), sensorBytes); // sensor-owned file untouched — no rewrite, no quarantine
    assert.ok(!existsSync(path.join(d5, 'survey', 'events.quarantine.jsonl')));
    mirror.stop();
  } finally {
    process.env.COBRA_DATA_DIR = TEST_DATA;
    rmSync(d5, { recursive: true, force: true });
  }
});

// MEMORY-0B §1 — a parseable source record whose adapter output fails
// canonical validation is LOST evidence: health degrades, nothing else moves.
test('CANONICAL REJECTION IN THE MIRROR: invalid source timestamp degrades health; Serpent state untouched', () => {
  const d6 = mkdtempSync(path.join(tmpdir(), 'cobra-mirror6-'));
  process.env.COBRA_DATA_DIR = d6;
  try {
    const file = path.join(d6, 'rumint', 'events.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
    const postureFile = path.join(d6, 'state', 'posture.json');
    mkdirSync(path.dirname(postureFile), { recursive: true });
    writeFileSync(postureFile, JSON.stringify({ posture: 'COILED', cause: 'boot' }));
    const mirror = startMemoryMirror({ log: () => {} });
    // parseable JSON, but its ts is not a time — the adapter's envelope
    // will carry an invalid canonical ts and the bus must refuse it
    appendFileSync(file, j({ ts: 'NOT A TIME', type: 'RUMINT_POLL', symbol: 'BTC', velocity: 3 }));
    const sensorBytes = readFileSync(file, 'utf8');
    const postureBytes = readFileSync(postureFile, 'utf8');
    mirror.poll();
    const h = mirror.health();
    assert.equal(h.acceptedCount, 0);
    assert.ok(h.rejectedCount >= 1);
    assert.ok(h.canonicalRejectedErrors >= 1);
    assert.equal(h.status, 'DEGRADED'); // memory does not call itself HEALTHY after losing evidence
    assert.equal(h.sourceParseErrors, 0); // the failure class is distinguished
    assert.equal(readFileSync(file, 'utf8'), sensorBytes); // sensor untouched
    assert.equal(readFileSync(postureFile, 'utf8'), postureBytes); // trading state untouched
    assert.ok(!existsSync(path.join(d6, 'memory', 'events.jsonl'))); // nothing invalid persisted
    mirror.stop();
  } finally {
    process.env.COBRA_DATA_DIR = TEST_DATA;
    rmSync(d6, { recursive: true, force: true });
  }
});

// THE ARCHITECTURAL PROOF: no return path exists in the source graph.
test('NO RETURN PATH: only fly.js touches memory/, and memory/ imports no sensor or state machinery', () => {
  const root = path.join(import.meta.dirname, '..');
  const jsFiles = (dir) =>
    readdirSync(path.join(root, dir))
      .filter((f) => f.endsWith('.js'))
      .map((f) => path.join(dir, f));
  const sensorDirs = ['tape', 'survey', 'rumint', 'gateway', 'governance', 'cost', 'state', 'ledger', 'ui', 'childhood', 'lib'];
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
  // 3) the composition root wires the mirror inside its own containment,
  // and opens it BEFORE the live sensors begin writing (MEMORY-0A §8)
  const fly = readFileSync(path.join(root, 'fly.js'), 'utf8');
  assert.ok(fly.includes("./memory/mirror.js"));
  const mirrorAt = fly.indexOf('startMemoryMirror(');
  assert.ok(mirrorAt > 0);
  for (const sensor of ['startRumint(', 'startGateway()', 'startWideEye()', 'startGovernance(', 'runTape(']) {
    assert.ok(mirrorAt < fly.indexOf(sensor), `${sensor} starts before the memory mirror opens`);
  }
});
