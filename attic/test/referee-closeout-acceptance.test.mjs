// Acceptance assertions: these are meant to FAIL on the unrepaired source.
// Run from the repository root, or set SERPENT_REVIEW_ROOT to that root.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const ROOT = path.resolve(process.env.SERPENT_REVIEW_ROOT || process.cwd());
const mod = (p) => import(pathToFileURL(path.join(ROOT, p)));
const { prospectiveSetup, registryWith, manifest, condition, HOUR, MIN } = await mod('test/helpers/referee.js');
const { canonicalDigest, REGISTRY_VERSION, REASON_CODES } = await mod('research/referee/contracts.js');
const { createRegistry, registryError, registrySnapshot, registryFromSnapshot, appendRecord, experimentOf } = await mod('research/referee/registry.js');
const { captureProspectiveObservation, recordProspectiveOutcome, evaluateProspectiveTerminal } = await mod('research/referee/prospective.js');
const { appendRegistryFile, readRegistryFile } = await mod('research/referee/store.js');
const s = prospectiveSetup({ terminalObservations: 5 });
const clone = (x) => structuredClone(x);
function rehash(reg) {
 let prev = canonicalDigest({ registryVersion: REGISTRY_VERSION, genesis: true });
 for (const r of reg.records) { r.prevDigest = prev; const { digest, ...body } = r; r.digest = canonicalDigest(body); prev = r.digest; }
 return reg;
}
function alteredOpening(change) {
 const reg = clone(s.registry); const p = reg.records.find(r => r.kind === 'PROSPECTIVE_OPENED').payload;
 change(p); p.designDigest = canonicalDigest(p.design); return rehash(reg);
}
function refusal(result) {
 assert.ok(result && result.error, 'must return a structured refusal');
 assert.ok(REASON_CODES.includes(result.error.reason), 'refusal must use a declared reason');
}
function scratch(fn) {
 const dir = fs.mkdtempSync(path.join(tmpdir(), 'serpent-closeout-'));
 try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function growingRegistries() {
 const a = manifest();
 return { one: registryWith([a]).registry, two: registryWith([a, manifest({ signal: { feature: 'SIG', condition: condition('GT', 0.5) } })]).registry };
}
function mature() {
 let reg = s.registry; const obs = [];
 for (let i = 0; i < 5; i++) {
  const ts = s.openedAtTs + MIN + i;
  const o = { observationId: `accept-${i}`, symbol: 'BTC', ts, score: i % 2 ? -1 : 1, labelEndTs: ts + HOUR };
  const r = captureProspectiveObservation(reg, { experimentId: s.experimentId, observation: o, ts });
  assert.equal(r.error, null); reg = r.registry; obs.push(o);
 }
 const ts = obs.at(-1).labelEndTs + MIN;
 for (const [i, o] of obs.entries()) {
  const r = recordProspectiveOutcome(reg, { experimentId: s.experimentId, observationId: o.observationId, outcome: (i + 1) / 10, outcomeKnownAtTs: o.labelEndTs, ts });
  assert.equal(r.error, null); reg = r.registry;
 }
 const result = evaluateProspectiveTerminal(reg, { experimentId: s.experimentId, ts: ts + 1 });
 assert.equal(result.error, null); return { pending: reg, result, ts: ts + 1 };
}

test('A01 changed terminal count is refused by semantic validation, snapshot and file reload', () => {
 const reg = alteredOpening(p => { p.design.terminalObservations = 1; });
 assert.equal(experimentOf(reg, s.experimentId).manifest.prospective.terminalObservations, 5);
 assert.ok(registryError(reg), 'registered FIVE cannot become sealed ONE');
 refusal(registryFromSnapshot(registrySnapshot(reg)));
 scratch(dir => {
  const f = path.join(dir, 'r.jsonl'); fs.writeFileSync(f, reg.records.map(r => JSON.stringify(r)).join('\n') + '\n');
  assert.throws(() => readRegistryFile(f), /CORRUPT_INPUT|VALIDATION_FAILURE|PROSPECTIVE|SCHEMA/);
 });
});
test('A02 generic opening append cannot bypass the registered terminal count', () => {
 const reg = alteredOpening(p => { p.design.terminalObservations = 1; });
 const opening = reg.records.at(-1); const prefix = { registryVersion: REGISTRY_VERSION, records: reg.records.slice(0, -1) };
 refusal(appendRecord(prefix, { kind: opening.kind, ts: opening.ts, experimentId: opening.experimentId, payload: opening.payload }));
});
test('A03 rejected historical result cannot retain a prospective opening on reload', () => {
 const reg = clone(s.registry); reg.records.find(r => r.kind === 'RESULT_RECORDED').payload.verdict = 'REJECTED';
 refusal(registryFromSnapshot(registrySnapshot(rehash(reg))));
});
test('A04 opening must name the historical report actually recorded', () => {
 const reg = alteredOpening(p => { p.historicalReportDigest = '0'.repeat(64); });
 refusal(registryFromSnapshot(registrySnapshot(reg)));
});
test('A05 capture validates its incoming registry before extending it', () => {
 const reg = alteredOpening(p => { p.design.terminalObservations = 1; });
 const ts = s.openedAtTs + MIN;
 refusal(captureProspectiveObservation(reg, { experimentId: s.experimentId, ts, observation: { observationId: 'bad-base', symbol: 'BTC', ts, score: 1, labelEndTs: ts + HOUR } }));
});
test('A06 replay refuses an experiment-family mismatch on an existing experiment', () => {
 const reg = clone(s.registry); reg.records.at(-1).experimentFamilyId = 'fam_other';
 refusal(registryFromSnapshot(registrySnapshot(rehash(reg))));
});
for (const [id, key, value] of [
 ['A07', 'verdict', 'LIVE_APPROVED'],
 ['A08', 'reasons', ['MADE_UP']],
 ['A09', 'designDigest', '0'.repeat(64)],
 ['A10', 'reportDigest', '1'.repeat(64)],
]) test(`${id} terminal payload mutation ${key} is refused`, () => {
 const m = mature(); const payload = clone(m.result.registry.records.at(-1).payload); payload[key] = value;
 refusal(appendRecord(m.pending, { kind: 'PROSPECTIVE_EVALUATED', experimentId: s.experimentId, ts: m.ts, payload }));
});
test('W01 complete JSON without the terminating newline is not an appendable registry', () => scratch(dir => {
 const { one, two } = growingRegistries(); const f = path.join(dir, 'r.jsonl');
 appendRegistryFile(f, createRegistry(), one);
 fs.writeFileSync(f, fs.readFileSync(f).subarray(0, -1)); const before = fs.readFileSync(f);
 assert.throws(() => readRegistryFile(f), /CORRUPT_INPUT|INCOMPLETE|RECOVERY|UNCERTAIN/);
 assert.throws(() => appendRegistryFile(f, one, one));
 assert.throws(() => appendRegistryFile(f, one, two));
 assert.deepEqual(fs.readFileSync(f), before);
}));
test('W02 failure just before the newline stays refused on read and retry', () => scratch(dir => {
 const { one } = growingRegistries(); const f = path.join(dir, 'r.jsonl'); let calls = 0;
 const io = { writeSync(fd, buf, off, len) { if (++calls === 1) return fs.writeSync(fd, buf, off, len - 1); throw new Error('fault-before-newline'); } };
 assert.throws(() => appendRegistryFile(f, createRegistry(), one, { io }), /PARTIAL_WRITE_UNCERTAIN|RECOVERY|UNCERTAIN/);
 const bytes = fs.readFileSync(f); assert.ok(bytes.length > 0);
 assert.throws(() => readRegistryFile(f), /CORRUPT_INPUT|INCOMPLETE|RECOVERY|UNCERTAIN/);
 assert.throws(() => appendRegistryFile(f, createRegistry(), one));
 assert.deepEqual(fs.readFileSync(f), bytes);
}));
test('W03 failure between complete records blocks consumption of an uncertain batch', () => scratch(dir => {
 const { one, two } = growingRegistries(); const f = path.join(dir, 'r.jsonl'); let calls = 0;
 const io = { writeSync(fd, buf, off, len) { if (++calls === 1) return fs.writeSync(fd, buf, off, len); throw new Error('fault-between-records'); } };
 assert.throws(() => appendRegistryFile(f, createRegistry(), two, { io }), /PARTIAL_WRITE_UNCERTAIN|RECOVERY|UNCERTAIN/);
 const bytes = fs.readFileSync(f); assert.ok(bytes.length > 0);
 assert.throws(() => readRegistryFile(f), /CORRUPT_INPUT|INCOMPLETE|RECOVERY|UNCERTAIN/);
 assert.throws(() => appendRegistryFile(f, one, two));
 assert.deepEqual(fs.readFileSync(f), bytes);
}));
test('W04 fsync failure after data writes blocks reads and retries pending recovery', () => scratch(dir => {
 const { one } = growingRegistries(); const f = path.join(dir, 'r.jsonl'); let wrote = false;
 // Existing io injection is for registry DATA operations; keep that contract.
 const io = { writeSync(fd, buf, off, len) { const n = fs.writeSync(fd, buf, off, len); wrote = true; return n; }, fsyncSync(fd) { if (wrote) throw new Error('fault-at-data-fsync'); return fs.fsyncSync(fd); } };
 assert.throws(() => appendRegistryFile(f, createRegistry(), one, { io }), /PARTIAL_WRITE_UNCERTAIN|RECOVERY|UNCERTAIN/);
 const bytes = fs.readFileSync(f); assert.ok(bytes.length > 0);
 assert.throws(() => readRegistryFile(f), /CORRUPT_INPUT|INCOMPLETE|RECOVERY|UNCERTAIN/);
 assert.throws(() => appendRegistryFile(f, createRegistry(), one));
 assert.deepEqual(fs.readFileSync(f), bytes);
}));
test('P01 valid five-capture lifecycle commits, reloads and still permits only one terminal result', () => scratch(dir => {
 const m = mature(); const reg = m.result.registry;
 assert.equal(m.result.report.terminal.counted, 5);
 assert.deepEqual(m.result.report.terminal.observationIds, ['accept-0', 'accept-1', 'accept-2', 'accept-3', 'accept-4']);
 assert.equal(registryError(reg), null); assert.equal(registryFromSnapshot(registrySnapshot(reg)).error, null);
 const f = path.join(dir, 'r.jsonl'); appendRegistryFile(f, createRegistry(), reg);
 const back = readRegistryFile(f); assert.equal(experimentOf(back, s.experimentId).status, 'PROSPECTIVE_EVALUATED');
 refusal(evaluateProspectiveTerminal(back, { experimentId: s.experimentId, ts: m.ts + 1 }));
 assert.equal(appendRegistryFile(f, back, back).appended, 0);
}));
