// RESEARCH REFEREE REPAIR — P. the prospective time and recording rules, W. the registry writer.
//
// Two defects were independently reproduced on commit e12536a and are pinned here:
//   P0  a lawful opening at T accepted an observation recorded at T+1 whose decision was T+1000 and whose outcome was
//       "known" an hour later; a formal evaluation at T+2 then succeeded. No outcome can be known that early.
//   W0  appendRegistryFile trusted the caller's `previous` registry instead of the stored file, so the same one-record
//       append performed twice produced a file that readRegistryFile then refused as REGISTRY_CHAIN_BROKEN.
// Both reproductions are the first assertion of their section. The rest is the boundary the repair has to hold: a
// two-stage append-only lifecycle (capture, then a separate outcome), clock ordering at every entry path including
// replay, the first-N-CAPTURED sample, one durable formal look, and a writer that treats the stored file as truth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync, writeSync as fsWriteSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { refereeEvaluate } from '../research/referee/evaluate.js';
import { createRegistry, registryError, registrySnapshot, registryFromSnapshot, experimentOf } from '../research/referee/registry.js';
import { REGISTRY_VERSION } from '../research/referee/contracts.js';
import { readRegistryFile, appendRegistryFile, REGISTRY_LOCK_SUFFIX } from '../research/referee/store.js';
import { openProspective, captureProspectiveObservation, recordProspectiveOutcome, prospectiveProgress, evaluateProspectiveTerminal, INTERIM_BANNER } from '../research/referee/prospective.js';
import { prospectiveSetup, registryWith, manifest, feature, condition, realEffectData, bundleFor, synth, mix, HOUR, MIN } from './helpers/referee.js';

const CHILD = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'helpers/referee-append-child.mjs');
const work = () => mkdtempSync(path.join(tmpdir(), 'referee-repair-'));
const bytesOf = (f) => (existsSync(f) ? readFileSync(f) : null);
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// one lawful capture relative to a setup opened at `openedAtTs`
const cap = (s, n) => { const ts = s.openedAtTs + 10 + n * 5 * MIN; return { observationId: `p-${n}`, symbol: 'BTC', ts, score: 1, labelEndTs: ts + HOUR }; };
// recompute prevDigest / digest exactly as the registry does, so a forged history is hash-VALID and only its semantics are wrong
const canon = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : `{${Object.keys(v).sort().map((k) => (v[k] === undefined ? null : `${JSON.stringify(k)}:${canon(v[k])}`)).filter(Boolean).join(',')}}`);
const sha = (v) => createHash('sha256').update(canon(v)).digest('hex');
function rehash(records) {
  let prev = sha({ registryVersion: REGISTRY_VERSION, genesis: true });
  return records.map((r, i) => { const rec = { ...r, seq: i + 1, prevDigest: prev }; rec.digest = sha({ seq: rec.seq, kind: rec.kind, ts: rec.ts, experimentId: rec.experimentId, experimentFamilyId: rec.experimentFamilyId, payload: rec.payload, prevDigest: rec.prevDigest }); prev = rec.digest; return rec; });
}

// ---------------------------------------------------------------------------------------------------------------
// P. the prospective time and recording rules
// ---------------------------------------------------------------------------------------------------------------

test('P0 (REPRODUCTION). the reported failure: after a lawful opening at T, an observation recorded at T+1 whose decision is T+1000 and whose outcome is known an hour later is REFUSED, and no formal evaluation at T+2 can follow it', () => {
  const s = prospectiveSetup({ terminalObservations: 1 }); const T = s.openedAtTs;
  const future = captureProspectiveObservation(s.registry, { experimentId: s.experimentId, observation: { observationId: 'p-1', symbol: 'BTC', ts: T + 1000, score: 1, labelEndTs: T + 1000 + HOUR }, ts: T + 1 });
  assert.equal(future.error?.reason, 'DECISION_AFTER_RECORDING', 'a decision cannot be later than the time it is recorded');
  assert.equal(future.registry.records.length, s.registry.records.length, 'nothing was appended');
  const o = cap(s, 1);
  const ok = captureProspectiveObservation(s.registry, { experimentId: s.experimentId, observation: o, ts: o.ts + MIN }); assert.equal(ok.error, null);
  const early = recordProspectiveOutcome(ok.registry, { experimentId: s.experimentId, observationId: 'p-1', outcome: 0.5, outcomeKnownAtTs: o.labelEndTs, ts: o.labelEndTs - 1 });
  assert.equal(early.error?.reason, 'OUTCOME_RECORDED_BEFORE_KNOWN', 'a known outcome cannot be recorded before it is known');
  const term = evaluateProspectiveTerminal(ok.registry, { experimentId: s.experimentId, ts: T + 2 });
  assert.equal(term.report, null); assert.ok(['TERMINAL_SAMPLE_NOT_REACHED', 'REGISTRY_CLOCK_BACKWARDS'].includes(term.error.reason), term.error.reason);
});

test('P1. clock ordering at capture: the design must be sealed first, the decision cannot follow its recording, the horizon must match, the capture must precede the label end, and a backwards registry clock is refused before anything changes', () => {
  const s = prospectiveSetup(); const T = s.openedAtTs; const good = cap(s, 1); const rec = good.ts + MIN;
  assert.equal(captureProspectiveObservation(s.registry, { experimentId: s.experimentId, observation: { ...good, ts: T - MIN, labelEndTs: T - MIN + HOUR }, ts: rec }).error.reason, 'EVALUATION_BEFORE_REGISTRATION', 'decided before the design was sealed');
  assert.equal(captureProspectiveObservation(s.registry, { experimentId: s.experimentId, observation: { ...good, labelEndTs: good.ts + 2 * HOUR }, ts: rec }).error.reason, 'LABEL_HORIZON_MISMATCH');
  assert.equal(captureProspectiveObservation(s.registry, { experimentId: s.experimentId, observation: good, ts: good.labelEndTs }).error.reason, 'CAPTURE_NOT_PRIOR_TO_OUTCOME', 'a score first supplied once the window has closed is not a prospective prediction');
  const back = captureProspectiveObservation(s.registry, { experimentId: s.experimentId, observation: good, ts: s.registry.records[s.registry.records.length - 1].ts - 1 });
  assert.equal(back.error.reason, 'REGISTRY_CLOCK_BACKWARDS'); assert.equal(back.registry.records.length, s.registry.records.length);
  for (const bad of [{ ...good, symbol: 'DOGE' }, { ...good, ts: 'soon' }, { ...good, score: Infinity }, { ...good, observationId: '' }, { ...good, extra: 1 }]) assert.ok(captureProspectiveObservation(s.registry, { experimentId: s.experimentId, observation: bad, ts: rec }).error, `refused: ${JSON.stringify(bad)}`);
  const ok = captureProspectiveObservation(s.registry, { experimentId: s.experimentId, observation: good, ts: rec });
  assert.equal(ok.error, null); const r = ok.registry.records[ok.registry.records.length - 1];
  assert.equal(r.kind, 'PROSPECTIVE_OBSERVATION'); assert.equal(r.payload.position, 1); assert.equal(r.payload.captureEvidence, 'IN_REGISTRY_PRIOR_CAPTURE');
  assert.equal('outcome' in r.payload, false, 'a capture carries no outcome');
});

test('P2. the two-stage lifecycle: a capture whose outcome is unknown can later receive exactly one mature outcome; a duplicate capture, a duplicate outcome, an orphan outcome and any attempt to revise the recorded score are refused', () => {
  const s = prospectiveSetup(); const o = cap(s, 1); let reg = captureProspectiveObservation(s.registry, { experimentId: s.experimentId, observation: o, ts: o.ts + MIN }).registry;
  assert.equal(captureProspectiveObservation(reg, { experimentId: s.experimentId, observation: o, ts: o.ts + 2 * MIN }).error.reason, 'DUPLICATE_OBSERVATION_ID');
  assert.equal(captureProspectiveObservation(reg, { experimentId: s.experimentId, observation: { ...o, score: 99 }, ts: o.ts + 2 * MIN }).error.reason, 'DUPLICATE_OBSERVATION_ID', 'a second capture cannot replace the recorded score');
  assert.equal(recordProspectiveOutcome(reg, { experimentId: s.experimentId, observationId: 'ghost', outcome: 1, outcomeKnownAtTs: o.labelEndTs, ts: o.labelEndTs }).error.reason, 'PROSPECTIVE_OBSERVATION_UNKNOWN');
  assert.equal(recordProspectiveOutcome(reg, { experimentId: s.experimentId, observationId: 'p-1', outcome: 1, outcomeKnownAtTs: o.labelEndTs - 1, ts: o.labelEndTs }).error.reason, 'OUTCOME_KNOWN_BEFORE_HORIZON_END');
  assert.equal(recordProspectiveOutcome(reg, { experimentId: s.experimentId, observationId: 'p-1', outcome: NaN, outcomeKnownAtTs: o.labelEndTs, ts: o.labelEndTs }).error.reason, 'SCHEMA');
  const done = recordProspectiveOutcome(reg, { experimentId: s.experimentId, observationId: 'p-1', outcome: 0.4, outcomeKnownAtTs: o.labelEndTs, ts: o.labelEndTs + MIN });
  assert.equal(done.error, null); reg = done.registry; const rec = reg.records[reg.records.length - 1];
  assert.equal(rec.kind, 'PROSPECTIVE_OUTCOME'); assert.deepEqual(Object.keys(rec.payload).sort(), ['designDigest', 'observationId', 'outcome', 'outcomeKnownAtTs'], 'an outcome record carries nothing that could revise the capture');
  assert.equal(recordProspectiveOutcome(reg, { experimentId: s.experimentId, observationId: 'p-1', outcome: 9, outcomeKnownAtTs: o.labelEndTs, ts: o.labelEndTs + 2 * MIN }).error.reason, 'PROSPECTIVE_OUTCOME_ALREADY_RECORDED');
  const captured = reg.records.find((r) => r.kind === 'PROSPECTIVE_OBSERVATION');
  assert.equal(captured.payload.score, 1); assert.equal(captured.payload.ts, o.ts); assert.equal(captured.payload.symbol, 'BTC');
});

test('P3. the sample is the first N CAPTURED observations: a missing outcome keeps the formal evaluation pending, outcomes arriving out of order neither reorder nor replace the sample, and progress stays descriptive', () => {
  const s = prospectiveSetup({ terminalObservations: 3 }); let reg = s.registry; const obs = [1, 2, 3, 4].map((n) => cap(s, n));
  for (const o of obs) { const r = captureProspectiveObservation(reg, { experimentId: s.experimentId, observation: o, ts: o.ts + MIN }); assert.equal(r.error, null, JSON.stringify(r.error)); reg = r.registry; }
  const matureTs = obs[3].labelEndTs + MIN;
  for (const n of [3, 1, 4]) { const r = recordProspectiveOutcome(reg, { experimentId: s.experimentId, observationId: `p-${n}`, outcome: 0.1 * n, outcomeKnownAtTs: obs[n - 1].labelEndTs, ts: matureTs }); assert.equal(r.error, null, JSON.stringify(r.error)); reg = r.registry; }
  const p = prospectiveProgress(reg, s.experimentId);
  assert.equal(p.counted, 3); assert.equal(p.withOutcome, 2); assert.deepEqual(p.countedObservationIds, ['p-1', 'p-2', 'p-3'], 'the first three CAPTURED, not the first three completed');
  assert.equal(p.formal.status, 'TERMINAL_SAMPLE_NOT_REACHED'); assert.equal(p.interim.banner, INTERIM_BANNER);
  assert.equal(evaluateProspectiveTerminal(reg, { experimentId: s.experimentId, ts: matureTs + MIN }).error.reason, 'TERMINAL_SAMPLE_NOT_REACHED');
  reg = recordProspectiveOutcome(reg, { experimentId: s.experimentId, observationId: 'p-2', outcome: 0.2, outcomeKnownAtTs: obs[1].labelEndTs, ts: matureTs + MIN }).registry;
  const p2 = prospectiveProgress(reg, s.experimentId); assert.equal(p2.formal.status, 'TERMINAL_SAMPLE_REACHED'); assert.deepEqual(p2.countedObservationIds, ['p-1', 'p-2', 'p-3']);
  const done = evaluateProspectiveTerminal(reg, { experimentId: s.experimentId, ts: matureTs + 2 * MIN });
  assert.equal(done.error, null); assert.equal(done.report.terminal.counted, 3); assert.deepEqual(done.report.terminal.observationIds, ['p-1', 'p-2', 'p-3']);
});

test('P4. the formal look: it cannot precede the records it uses, it happens once, the refusal survives a reload, and the null seed is bound at opening rather than chosen at the final look', () => {
  const s = prospectiveSetup({ terminalObservations: 2 }); let reg = s.registry; const obs = [1, 2].map((n) => cap(s, n));
  for (const o of obs) reg = captureProspectiveObservation(reg, { experimentId: s.experimentId, observation: o, ts: o.ts + MIN }).registry;
  for (const [i, o] of obs.entries()) reg = recordProspectiveOutcome(reg, { experimentId: s.experimentId, observationId: `p-${i + 1}`, outcome: 0.3, outcomeKnownAtTs: o.labelEndTs, ts: o.labelEndTs + MIN }).registry;
  const lastTs = reg.records[reg.records.length - 1].ts;
  assert.equal(evaluateProspectiveTerminal(reg, { experimentId: s.experimentId, ts: lastTs - 1 }).error.reason, 'REGISTRY_CLOCK_BACKWARDS');
  assert.ok(s.design.nullSeed, 'the seed is sealed in the design');
  assert.equal(evaluateProspectiveTerminal(reg, { experimentId: s.experimentId, ts: lastTs + 1, seed: 'chosen-later' }).error.reason, 'SCHEMA', 'a seed cannot be chosen at the final look');
  const first = evaluateProspectiveTerminal(reg, { experimentId: s.experimentId, ts: lastTs + 1 }); assert.equal(first.error, null); reg = first.registry;
  assert.ok(first.report.terminal.seed.includes(s.design.nullSeed), 'the report names the sealed seed');
  assert.equal(evaluateProspectiveTerminal(reg, { experimentId: s.experimentId, ts: lastTs + 2 }).error.reason, 'STATUS_TRANSITION_REFUSED');
  const dir = work(); try {
    const file = path.join(dir, 'registry.jsonl'); appendRegistryFile(file, createRegistry(), reg);
    const back = readRegistryFile(file); assert.equal(experimentOf(back, s.experimentId).status, 'PROSPECTIVE_EVALUATED');
    assert.equal(evaluateProspectiveTerminal(back, { experimentId: s.experimentId, ts: lastTs + 3 }).error.reason, 'STATUS_TRANSITION_REFUSED', 'no second final look after a restart');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P5. replay validates semantics, not only hashes: correctly rehashed but unlawful prospective histories are refused on reload and before scoring, and an orphan record is refused with its own reason', () => {
  const s = prospectiveSetup(); const o = cap(s, 1);
  const reg = captureProspectiveObservation(s.registry, { experimentId: s.experimentId, observation: o, ts: o.ts + MIN }).registry;
  assert.equal(registryError(reg), null); assert.equal(registryFromSnapshot(registrySnapshot(reg)).error, null);
  const clone = () => reg.records.map((r) => ({ ...r, payload: structuredClone(r.payload) }));
  const futureDecision = rehash(clone().map((r) => (r.kind === 'PROSPECTIVE_OBSERVATION' ? { ...r, payload: { ...r.payload, ts: r.ts + 10 * MIN, labelEndTs: r.ts + 10 * MIN + HOUR } } : r)));
  const err = registryError({ registryVersion: REGISTRY_VERSION, records: futureDecision });
  assert.equal(err?.reason, 'DECISION_AFTER_RECORDING', 'an unlawful but correctly rehashed record is refused');
  assert.ok(registryFromSnapshot({ registryVersion: REGISTRY_VERSION, headSeq: futureDecision.length, headDigest: futureDecision[futureDecision.length - 1].digest, records: futureDecision }).error, 'and it is refused before scoring');
  const orphan = rehash(clone().filter((r) => r.kind !== 'PROSPECTIVE_OPENED'));
  assert.equal(registryError({ registryVersion: REGISTRY_VERSION, records: orphan })?.reason, 'PROSPECTIVE_NOT_OPENED');
  const dir = work(); try {
    const file = path.join(dir, 'r.jsonl'); for (const r of futureDecision) appendFileSync(file, `${JSON.stringify(r)}\n`);
    assert.throws(() => readRegistryFile(file), /DECISION_AFTER_RECORDING/);
    const vFile = path.join(dir, 'v.jsonl'); writeFileSync(vFile, `${JSON.stringify({ ...reg.records[0], kind: 'PROSPECTIVE_TELEPORT' })}\n`);
    assert.throws(() => readRegistryFile(vFile), /CORRUPT_INPUT/, 'an unsupported record kind is refused, never reinterpreted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P6. the sealed design freezes the CANDIDATE that was actually evaluated: a primary candidate whose feature differs from manifest.signal is sealed with its own feature and threshold, never a mixture', () => {
  const data = synth({ seed: 'candidate-seal', steps: 400, features: (rng, y) => ({ SIG: rng.normal(), ALT: mix(rng, y, 0.4) }) });
  const { bundle, registry } = bundleFor({ data, manifestOver: { features: [feature('SIG'), feature('ALT')], signal: { feature: 'SIG', condition: condition('GT', 0) }, candidates: [{ candidateId: 'c-alt', params: { k: 1 }, signal: { feature: 'ALT', condition: condition('GT', 0.25) } }], primaryCandidateId: 'c-alt', prospective: { terminalObservations: 10, horizonMs: HOUR, universeRule: 'DECLARED_STATIC_LIST', sequentialMethod: null } } });
  const report = refereeEvaluate(bundle);
  assert.equal(report.primaryResult.fit.feature, 'ALT', 'the report names the evaluated feature');
  assert.equal(report.primaryResult.fit.candidateId, 'c-alt');
  const s = prospectiveSetup({ bundle, registry, report });
  assert.equal(s.design.feature, 'ALT', 'the sealed design freezes the evaluated candidate, not manifest.signal');
  assert.equal(s.design.condition.threshold, 0.25); assert.equal(s.design.candidateId, 'c-alt');
  assert.equal(s.design.featureDefinitionDigest, bundle.experiment.features.find((f) => f.name === 'ALT').definitionDigest);
});

// ---------------------------------------------------------------------------------------------------------------
// W. the registry writer
// ---------------------------------------------------------------------------------------------------------------
const twoRegistries = () => ({
  a: registryWith([manifest({ name: 'w-a' })]).registry,
  b: registryWith([manifest({ name: 'w-b', familyTag: 'OTHER_FAMILY', features: [feature('OTHER')], signal: { feature: 'OTHER', condition: condition('GT', 0) } })]).registry,
});

test('W0 (REPRODUCTION). the reported failure: the same append performed twice from an empty expected state is refused the second time, no byte changes, and the stored history still reads', () => {
  const dir = work(); try {
    const file = path.join(dir, 'registry.jsonl'); const { a } = twoRegistries();
    assert.equal(appendRegistryFile(file, createRegistry(), a).appended, 1);
    const before = bytesOf(file);
    assert.throws(() => appendRegistryFile(file, createRegistry(), a), /STALE_EXPECTED_STATE/, 'the stored file, not the caller, is the source of truth');
    assert.deepEqual(bytesOf(file), before, 'a refused append changes no byte');
    const back = readRegistryFile(file); assert.equal(back.records.length, 1); assert.equal(registryError(back), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('W1. the file is truth: a fresh append and a reload preserve exactly the expected records; a stale expected head, a divergent next, an empty-tail stale call and a missing file with nonempty expected history all refuse without writing', () => {
  const dir = work(); try {
    const file = path.join(dir, 'registry.jsonl'); const { a, b } = twoRegistries();
    appendRegistryFile(file, createRegistry(), a); const stored = readRegistryFile(file);
    assert.deepEqual(stored.records.map((r) => r.digest), a.records.map((r) => r.digest));
    const before = bytesOf(file);
    assert.throws(() => appendRegistryFile(file, createRegistry(), b), /STALE_EXPECTED_STATE|diverge/);
    assert.throws(() => appendRegistryFile(file, b, b), /STALE_EXPECTED_STATE/, 'a stale expected head is refused even with an empty tail');
    assert.throws(() => appendRegistryFile(file, a, b), /diverge/);
    assert.deepEqual(bytesOf(file), before);
    const missing = path.join(dir, 'absent.jsonl');
    assert.throws(() => appendRegistryFile(missing, a, a), /STALE_EXPECTED_STATE/, 'a missing file cannot stand in for nonempty history');
    assert.equal(existsSync(missing), false, 'the refused append created nothing');
    assert.equal(appendRegistryFile(file, stored, stored).appended, 0); assert.deepEqual(bytesOf(file), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('W2. two independent processes contending from the same stored head: exactly one append succeeds, the other reports lock contention or a stale state, the file reads as a valid chain and no lock is left behind', async () => {
  const dir = work(); try {
    const file = path.join(dir, 'registry.jsonl'); const barrier = path.join(dir, 'go');
    const kids = ['one', 'two'].map((tag) => { const k = spawn(process.execPath, [CHILD, file, barrier, tag], { stdio: ['ignore', 'pipe', 'pipe'] }); k.out = ''; k.stdout.on('data', (d) => { k.out += d; }); k.stderr.on('data', (d) => { k.out += d; }); return k; });
    while (!(existsSync(`${file}.ready-one`) && existsSync(`${file}.ready-two`))) nap(5); // deterministic barrier: both are inside the append call path before either proceeds
    writeFileSync(barrier, 'go');
    const codes = await Promise.all(kids.map((k) => new Promise((res) => k.on('exit', (c) => res(c)))));
    const outs = kids.map((k) => k.out.trim());
    assert.equal(outs.filter((o) => /^APPENDED/.test(o)).length, 1, `exactly one append: ${JSON.stringify(outs)}`);
    assert.equal(outs.filter((o) => /LOCK_CONTENTION|STALE_EXPECTED_STATE/.test(o)).length, 1, `the other is refused: ${JSON.stringify(outs)}`);
    assert.deepEqual(codes.slice().sort(), [0, 0]);
    const back = readRegistryFile(file); assert.equal(back.records.length, 1); assert.equal(registryError(back), null);
    assert.equal(existsSync(`${file}${REGISTRY_LOCK_SUFFIX}`), false, 'the lock is released');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('W3. bounds and integrity: exceeding a declared byte / line / record bound fails before writing; corrupt or truncated stored bytes are refused without alteration; a leftover lock is never stolen', () => {
  const dir = work(); try {
    const file = path.join(dir, 'registry.jsonl'); const { a } = twoRegistries();
    appendRegistryFile(file, createRegistry(), a); const before = bytesOf(file); const stored = readRegistryFile(file);
    const grown = registryWith([manifest({ name: 'w-a' }), manifest({ name: 'w-a2', signal: { feature: 'SIG', condition: condition('GT', 0.5) } })]).registry;
    assert.throws(() => appendRegistryFile(file, stored, grown, { maxFileBytes: 10 }), /RESOURCE_LIMIT_EXCEEDED/);
    assert.throws(() => appendRegistryFile(file, stored, grown, { maxLineBytes: 10 }), /RESOURCE_LIMIT_EXCEEDED/);
    assert.throws(() => appendRegistryFile(file, stored, grown, { maxRecords: 1 }), /RESOURCE_LIMIT_EXCEEDED/);
    assert.deepEqual(bytesOf(file), before, 'a bound refusal writes nothing');
    writeFileSync(`${file}${REGISTRY_LOCK_SUFFIX}`, JSON.stringify({ pid: 999999, note: 'leftover' }));
    assert.throws(() => appendRegistryFile(file, stored, grown), /LOCK_CONTENTION/, 'a leftover lock is never stolen on age alone');
    assert.deepEqual(bytesOf(file), before); rmSync(`${file}${REGISTRY_LOCK_SUFFIX}`);
    assert.equal(appendRegistryFile(file, stored, grown).appended, 1, 'and the append succeeds once the lock is lawfully cleared');
    const truncated = path.join(dir, 'truncated.jsonl'); writeFileSync(truncated, readFileSync(file, 'utf8').trim().slice(0, 40));
    const tBytes = bytesOf(truncated);
    assert.throws(() => readRegistryFile(truncated), /CORRUPT_INPUT/);
    assert.throws(() => appendRegistryFile(truncated, createRegistry(), a), /CORRUPT_INPUT/); assert.deepEqual(bytesOf(truncated), tBytes, 'corrupt history is never repaired or truncated');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('W4. an exercised write failure releases the lock, is reported honestly, leaves its evidence, and its uncertain tail can never later be mistaken for a valid complete append', () => {
  const dir = work(); try {
    const file = path.join(dir, 'registry.jsonl'); const { a } = twoRegistries(); let calls = 0;
    const io = { writeSync: (fd, buf, off, len) => { calls += 1; if (calls === 1) return fsWriteSync(fd, buf, off, Math.min(len, 12)); throw Object.assign(new Error('simulated device failure'), { code: 'ENOSPC' }); } };
    assert.throws(() => appendRegistryFile(file, createRegistry(), a, { io }), /PARTIAL_WRITE_UNCERTAIN/);
    assert.equal(existsSync(`${file}${REGISTRY_LOCK_SUFFIX}`), false, 'the lock is released on failure');
    assert.ok(existsSync(file), 'the evidence of the failed write is not deleted');
    assert.throws(() => readRegistryFile(file), /CORRUPT_INPUT/, 'the uncertain tail is refused, never treated as a complete append');
    assert.throws(() => appendRegistryFile(file, createRegistry(), a), /CORRUPT_INPUT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('W5. short writes complete: a writer that accepts only a few bytes per call still stores every record exactly once', () => {
  const dir = work(); try {
    const file = path.join(dir, 'registry.jsonl'); const { a } = twoRegistries();
    const io = { writeSync: (fd, buf, off, len) => fsWriteSync(fd, buf, off, Math.min(len, 7)) };
    assert.equal(appendRegistryFile(file, createRegistry(), a, { io }).appended, 1);
    const back = readRegistryFile(file); assert.equal(back.records.length, 1); assert.equal(registryError(back), null); assert.equal(back.records[0].digest, a.records[0].digest);
    assert.equal(typeof openProspective, 'function');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
