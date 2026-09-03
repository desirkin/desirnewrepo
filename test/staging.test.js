// B-0B §19.17-20 — staging failure safety, promotion, validator rejection,
// and the single authoritative schema contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = mkdtempSync(path.join(tmpdir(), 'cobra-staging-'));
process.env.COBRA_DATA_DIR = ROOT;

const { validateChildhood, EXPECTED_SCHEMA_VERSION } = await import('../childhood/validate.js');
const { promoteStaging } = await import('../childhood/promote.js');

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

let n = 0;
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

const obsRow = ({ id = 1, ...over } = {}) => ({
  id: `o${id}`,
  ts: 1000,
  symbol: 'TST',
  track: '1m',
  trackRole: 'PARITY_SCOUT',
  population: 'BASELINE',
  eventId: 'e1',
  setupClassification: 'BASELINE_SAMPLE',
  split: 'DISCOVERY',
  provenance: { priceState: { source: 'fixture', sourceTs: 940, availableTs: 1000, retrievedTs: 'T', kind: 'historical', form: 'raw' } },
  ...over,
});

function makeStaging(mutate = () => {}) {
  const dir = path.join(ROOT, `staging-${++n}`);
  mkdirSync(dir, { recursive: true });
  const files = {
    'observations.jsonl': jsonl([obsRow({ id: 1 }), obsRow({ id: 2, eventId: 'e2' })]),
    'outcomes.jsonl': jsonl([
      { id: 'o1', eventId: 'e1', outcomeTags: ['FIZZLE'] },
      { id: 'o2', eventId: 'e2', outcomeTags: ['RUN'] },
    ]),
    'governance.jsonl': jsonl([{ proposalId: 'p1', lock: { status: 'INEVITABILITY_UNKNOWN' } }]),
    'incidents.jsonl': jsonl([{ sourceId: 'i1', firstPublicTs: '2026-01-01T00:00:00.000Z' }]),
    'candles-1m.jsonl': jsonl([{ symbol: 'TST', intervalMin: 1, retrievedSec: 2000, candles: [[900, 1, 1, 1, 1, 1]] }]),
    'manifest.json': JSON.stringify({
      schemaVersion: EXPECTED_SCHEMA_VERSION,
      counts: { byTrack: { '1m': 2 }, governanceProposals: 1, incidents: 1 },
      splits: { '1m': { nominalSplitTs: 20000 } },
    }),
  };
  mutate(files);
  for (const [name, content] of Object.entries(files)) {
    if (content !== null) writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function makeAuthoritative() {
  const dir = path.join(ROOT, `childhood-${++n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'marker.json'), '{"generation":"previous"}');
  return dir;
}

// §19.18 STAGING PROMOTION — a valid staging promotes; the old archive is
// superseded (clearly named), never merged.
test('STAGING PROMOTION: valid staging becomes authoritative; the old archive is superseded, never merged', () => {
  const staging = makeStaging();
  const auth = makeAuthoritative();
  const r = promoteStaging(staging, auth, { now: () => 424242 });
  assert.equal(r.promoted, true);
  assert.equal(r.supersededPath, `${auth}-superseded-424242`);
  assert.equal(existsSync(staging), false); // staging renamed into place
  assert.equal(existsSync(path.join(auth, 'manifest.json')), true); // new generation live
  assert.equal(existsSync(path.join(auth, 'marker.json')), false); // NOT merged
  assert.equal(existsSync(path.join(r.supersededPath, 'marker.json')), true); // old generation preserved intact
  assert.equal(r.validation.observations, 2);
});

test('STAGING PROMOTION: first promotion with no prior archive works, nothing superseded', () => {
  const staging = makeStaging();
  const auth = path.join(ROOT, `childhood-${++n}`); // does not exist
  const r = promoteStaging(staging, auth);
  assert.equal(r.promoted, true);
  assert.equal(r.supersededPath, null);
  assert.equal(existsSync(path.join(auth, 'observations.jsonl')), true);
});

// §19.17 STAGING FAILURE SAFETY — failed validation leaves the authoritative
// archive byte-for-byte untouched and retains staging for inspection.
test('STAGING FAILURE SAFETY: invalid staging is refused; authoritative untouched; staging retained', () => {
  const staging = makeStaging((f) => {
    f['observations.jsonl'] += 'THIS LINE DOES NOT PARSE{{{\n';
  });
  const auth = makeAuthoritative();
  const before = readFileSync(path.join(auth, 'marker.json'), 'utf8');
  const r = promoteStaging(staging, auth);
  assert.equal(r.promoted, false);
  assert.equal(r.stage, 'validation');
  assert.ok(r.errors.some((e) => e.includes('does not parse')));
  assert.equal(readFileSync(path.join(auth, 'marker.json'), 'utf8'), before); // untouched
  assert.deepEqual(readdirSync(auth), ['marker.json']); // nothing added either
  assert.equal(existsSync(staging), true); // retained for inspection
  assert.equal(r.stagingRetainedAt, staging);
});

test('STAGING FAILURE SAFETY: a promotion failure AFTER displacing the old archive rolls it back', () => {
  const auth = makeAuthoritative();
  const ghostStaging = path.join(ROOT, 'staging-that-does-not-exist');
  const r = promoteStaging(ghostStaging, auth, { validate: () => ({ ok: true, errors: [], stats: {} }) });
  assert.equal(r.promoted, false);
  assert.equal(r.stage, 'promotion');
  assert.equal(r.rolledBack, true);
  assert.equal(existsSync(path.join(auth, 'marker.json')), true); // old archive restored
});

// §19.19 POST-BUILD VALIDATOR REJECTION — every class of corruption is caught.
test('VALIDATOR REJECTION: corrupted stagings are named and refused', () => {
  const cases = [
    ['duplicate observation id', (f) => (f['observations.jsonl'] = jsonl([obsRow({ id: 1 }), obsRow({ id: 1 })]))],
    ['carries outcome field', (f) => (f['observations.jsonl'] = jsonl([obsRow({ id: 1, mfe: { '1m': 2 } }), obsRow({ id: 2, eventId: 'e2' })]))],
    [
      'wide-eye classification',
      (f) => (f['observations.jsonl'] = jsonl([obsRow({ id: 1, trackRole: 'CONTEXT_ONLY', setupClassification: 'RIPPLE' }), obsRow({ id: 2, eventId: 'e2' })])),
    ],
    [
      'availableTs after observation ts',
      (f) =>
        (f['observations.jsonl'] = jsonl([
          obsRow({ id: 1, provenance: { priceState: { source: 'fixture', sourceTs: 940, availableTs: 1060, retrievedTs: 'T' } } }),
          obsRow({ id: 2, eventId: 'e2' }),
        ])),
    ],
    [
      'appears in both',
      (f) => (f['observations.jsonl'] = jsonl([obsRow({ id: 1, split: 'DISCOVERY' }), obsRow({ id: 2, split: 'VALIDATION' })])), // same eventId e1
    ],
    [
      'horizon crosses the boundary',
      (f) => (f['observations.jsonl'] = jsonl([obsRow({ id: 1, ts: 19000 }), obsRow({ id: 2, eventId: 'e2' })])), // 19000+14400 > 20000
    ],
    ['references unknown observation', (f) => (f['outcomes.jsonl'] = jsonl([{ id: 'oX', outcomeTags: ['FIZZLE'] }, { id: 'o1', outcomeTags: ['FIZZLE'] }]))],
    ['lacks outcomeTags', (f) => (f['outcomes.jsonl'] = jsonl([{ id: 'o1', label: 'RUN' }, { id: 'o2', outcomeTags: ['FIZZLE'] }]))],
    [
      'not closed by retrieval time',
      (f) => (f['candles-1m.jsonl'] = jsonl([{ symbol: 'TST', intervalMin: 1, retrievedSec: 2000, candles: [[900, 1, 1, 1, 1, 1], [1980, 1, 1, 1, 1, 1]] }])),
    ],
    ['missing retrievedSec', (f) => (f['candles-1m.jsonl'] = jsonl([{ symbol: 'TST', intervalMin: 1, candles: [[900, 1, 1, 1, 1, 1]] }]))],
    [
      'STATISTICALLY_NEAR_CERTAIN',
      (f) => (f['governance.jsonl'] = jsonl([{ proposalId: 'p1', lock: { status: 'STATISTICALLY_NEAR_CERTAIN' } }])),
    ],
    ['byTrack total', (f) => (f['manifest.json'] = f['manifest.json'].replace('"1m":2', '"1m":7'))],
    ['governance count mismatch', (f) => (f['manifest.json'] = f['manifest.json'].replace('"governanceProposals":1', '"governanceProposals":9'))],
  ];
  for (const [needle, mutate] of cases) {
    const dir = makeStaging(mutate);
    const v = validateChildhood(dir);
    assert.equal(v.ok, false, `corruption "${needle}" was not caught`);
    assert.ok(v.errors.some((e) => e.includes(needle)), `no error names "${needle}": ${JSON.stringify(v.errors)}`);
    const auth = makeAuthoritative();
    assert.equal(promoteStaging(dir, auth).promoted, false, `corruption "${needle}" was promoted`);
    assert.equal(existsSync(path.join(auth, 'marker.json')), true);
  }
});

// §19.20 SCHEMA CONTRACT — one authoritative schema, version-checked.
test('SCHEMA CONTRACT: the single authoritative B-0B schema version is enforced', () => {
  assert.equal(EXPECTED_SCHEMA_VERSION, 'childhood-observation-3-b0b');
  const stale = makeStaging((f) => {
    f['manifest.json'] = f['manifest.json'].replace(EXPECTED_SCHEMA_VERSION, 'childhood-observation-2');
  });
  const v = validateChildhood(stale);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('childhood-observation-2') && e.includes(EXPECTED_SCHEMA_VERSION)));
  const missing = makeStaging((f) => {
    f['manifest.json'] = null; // no manifest at all
  });
  assert.deepEqual(validateChildhood(missing).errors, ['manifest.json missing']);
  const clean = makeStaging();
  const v2 = validateChildhood(clean);
  assert.deepEqual(v2.errors, []);
  assert.equal(v2.ok, true);
  assert.deepEqual(v2.stats, { observations: 2, outcomes: 2, governance: 1, incidents: 1 });
});
