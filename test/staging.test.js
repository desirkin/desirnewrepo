// B-0B §19.17-20 — staging failure safety, promotion, validator rejection,
// and the single authoritative schema contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = mkdtempSync(path.join(tmpdir(), 'cobra-staging-'));
process.env.COBRA_DATA_DIR = ROOT;

const { validateChildhood, EXPECTED_SCHEMA_VERSION, CHILDHOOD_VERSION } = await import('../childhood/validate.js');
const { promoteStaging } = await import('../childhood/promote.js');

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

let n = 0;
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

// full six-family provenance (B-0B.1 §3); retrievedTs (2400s epoch) is
// AFTER the candle fixture's retrievedSec of 2000 (§4 ordering)
const RETRIEVED = '1970-01-01T00:40:00.000Z';
const fullProvenance = (retrievedTs = RETRIEVED) => ({
  priceState: { source: 'fixture bar', sourceTs: 940, availableTs: 1000, retrievedTs, kind: 'historical', form: 'raw' },
  volumeState: { source: 'fixture volume', sourceTs: 1000, availableTs: 1000, retrievedTs, kind: 'historical', form: 'derived' },
  marketContext: { source: 'fixture context', sourceTs: 1000, availableTs: 1000, retrievedTs, kind: 'historical', form: 'derived' },
  scoutSignals: { source: 'fixture eyecore', sourceTs: 1000, availableTs: 1000, retrievedTs, kind: 'historical', form: 'derived' },
  externalSignals: { source: 'none (no historical archive)', sourceTs: 'UNKNOWN', availableTs: 'UNKNOWN', retrievedTs, kind: 'historical', form: 'raw' },
  microstructure: { source: 'none (no L2 history)', sourceTs: 'UNKNOWN', availableTs: 'UNKNOWN', retrievedTs, kind: 'historical', form: 'raw' },
});

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
  provenance: fullProvenance(),
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
    'incidents.jsonl': jsonl([{ sourceId: 'i1', incidentId: 'i1', firstPublicTs: '2026-01-01T00:00:00.000Z' }]),
    'incident-outcomes.jsonl': jsonl([{ incidentId: 'i1', firstPublicTs: '2026-01-01T00:00:00.000Z', outcomes: {} }]),
    'candles-1m.jsonl': jsonl([{ symbol: 'TST', intervalMin: 1, retrievedSec: 2000, candles: [[900, 1, 1, 1, 1, 1]] }]),
    'manifest.json': JSON.stringify({
      schemaVersion: EXPECTED_SCHEMA_VERSION,
      childhoodVersion: CHILDHOOD_VERSION,
      tradesCoverage: { TST: { retrievedTs: '1970-01-01T00:50:00.000Z' } }, // trades clock: 3000s
      counts: {
        byTrack: { '1m': 2 },
        byPopulation: { BASELINE: 2 },
        bySplit: { DISCOVERY: 2 },
        byTrackRole: { PARITY_SCOUT: 2 },
        byTag: { FIZZLE: 1, RUN: 1 },
        governanceProposals: 1,
        incidents: 1,
        incidentOutcomes: 1,
      },
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
          obsRow({ id: 1, provenance: { ...fullProvenance(), priceState: { source: 'fixture bar', sourceTs: 940, availableTs: 1060, retrievedTs: RETRIEVED, kind: 'historical', form: 'raw' } } }),
          obsRow({ id: 2, eventId: 'e2' }),
        ])),
    ],
    // B-0B.1 §3: provenance on priceState alone is NOT enough
    [
      'volumeState provenance incomplete',
      (f) =>
        (f['observations.jsonl'] = jsonl([
          obsRow({ id: 1, provenance: { priceState: fullProvenance().priceState } }),
          obsRow({ id: 2, eventId: 'e2' }),
        ])),
    ],
    // B-0B.1 §4: an observation cannot claim retrieval before its source's
    // actual retrieval time (candles retrievedSec = 2000s; claim = 1200s)
    [
      'claims retrieval before source retrieval',
      (f) =>
        (f['observations.jsonl'] = jsonl([
          obsRow({ id: 1, provenance: fullProvenance('1970-01-01T00:20:00.000Z') }),
          obsRow({ id: 2, eventId: 'e2' }),
        ])),
    ],
    // B-0B.1 §7: EVERY candle is checked, not just the final row
    [
      'not closed by retrieval time',
      (f) =>
        (f['candles-1m.jsonl'] = jsonl([
          { symbol: 'TST', intervalMin: 1, retrievedSec: 2000, candles: [[900, 1, 1, 1, 1, 1], [1980, 1, 1, 1, 1, 1], [700, 1, 1, 1, 1, 1]] },
        ])),
    ],
    // B-0B.1 §7: per-key counter reconciliation
    ['byPopulation', (f) => (f['manifest.json'] = f['manifest.json'].replace('"byPopulation":{"BASELINE":2}', '"byPopulation":{"BASELINE":1,"TRIGGER":1}'))],
    ['bySplit', (f) => (f['manifest.json'] = f['manifest.json'].replace('"bySplit":{"DISCOVERY":2}', '"bySplit":{"DISCOVERY":1,"VALIDATION":1}'))],
    ['byTrackRole', (f) => (f['manifest.json'] = f['manifest.json'].replace('"byTrackRole":{"PARITY_SCOUT":2}', '"byTrackRole":{"PARITY_SCOUT":5}'))],
    ['byTag', (f) => (f['manifest.json'] = f['manifest.json'].replace('"byTag":{"FIZZLE":1,"RUN":1}', '"byTag":{"FIZZLE":2}'))],
    // B-0B.1 §8: the incident wall — facts never carry the future
    [
      'future field',
      (f) => (f['incidents.jsonl'] = jsonl([{ sourceId: 'i1', incidentId: 'i1', firstPublicTs: '2026-01-01T00:00:00.000Z', historicalOutcomes: { BTC: { ret1hPct: 1 } } }])),
    ],
    [
      'references unknown incident',
      (f) => (f['incident-outcomes.jsonl'] = jsonl([{ incidentId: 'iGHOST', firstPublicTs: '2026-01-01T00:00:00.000Z', outcomes: {} }])),
    ],
    ['incidentOutcomes count mismatch', (f) => (f['manifest.json'] = f['manifest.json'].replace('"incidentOutcomes":1', '"incidentOutcomes":3'))],
    // B-0B.2 §8: marketContext corrupted to a clock BEFORE its latest source
    // input (e.g. a build-start stamp taken before the fetches) must fail —
    // track's latest candle retrieval is 2000s, the claim is 1200s
    [
      'marketContext claims retrieval before its latest source input',
      (f) =>
        (f['observations.jsonl'] = jsonl([
          obsRow({
            id: 1,
            provenance: {
              ...fullProvenance(),
              marketContext: { source: 'fixture context', sourceTs: 1000, availableTs: 1000, retrievedTs: '1970-01-01T00:20:00.000Z', kind: 'historical', form: 'derived' },
            },
          }),
          obsRow({ id: 2, eventId: 'e2' }),
        ])),
    ],
    // B-0B.2 §9: KNOWN microstructure corrupted to the earlier OHLC clock
    // (2400s) while the manifest records the Trades retrieval at 3000s
    [
      'KNOWN microstructure claims retrieval before the trades retrieval',
      (f) =>
        (f['observations.jsonl'] = jsonl([
          obsRow({ id: 1, dataAvailability: { microstructure: 'KNOWN' } }),
          obsRow({ id: 2, eventId: 'e2' }),
        ])),
    ],
    // B-0B.2 §11: the manifest must identify the enforced generation
    ['childhoodVersion', (f) => (f['manifest.json'] = f['manifest.json'].replace(`"childhoodVersion":"${CHILDHOOD_VERSION}"`, '"childhoodVersion":"B0B"'))],
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

// B-0B.1 §2 — OUTCOME ONE-TO-ONE: the exact adversarial shape from the
// ticket: Observations A and B, Outcomes A and A (duplicate A, missing B).
test('OUTCOME ONE-TO-ONE: duplicate Outcome A + missing Outcome B is named and never promoted', () => {
  const dir = makeStaging((f) => {
    f['outcomes.jsonl'] = jsonl([
      { id: 'o1', eventId: 'e1', outcomeTags: ['FIZZLE'] },
      { id: 'o1', eventId: 'e1', outcomeTags: ['RUN'] }, // duplicate A
      // no Outcome for o2 (B)
    ]);
  });
  const v = validateChildhood(dir);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('duplicate outcome id o1')));
  assert.ok(v.errors.some((e) => e.includes('observation o2 has no outcome')));
  const auth = makeAuthoritative();
  assert.equal(promoteStaging(dir, auth).promoted, false);
  assert.equal(existsSync(path.join(auth, 'marker.json')), true); // untouched
  // and EXTRA outcomes fail too
  const extra = makeStaging((f) => {
    f['outcomes.jsonl'] = jsonl([
      { id: 'o1', eventId: 'e1', outcomeTags: ['FIZZLE'] },
      { id: 'o2', eventId: 'e2', outcomeTags: ['RUN'] },
      { id: 'oEXTRA', eventId: 'eX', outcomeTags: ['FIZZLE'] },
    ]);
  });
  const v2 = validateChildhood(extra);
  assert.equal(v2.ok, false);
  assert.ok(v2.errors.some((e) => e.includes('references unknown observation oEXTRA')));
  assert.ok(v2.errors.some((e) => e.includes('outcomes (3) != observations (2)')));
});

// B-0B.2A §7 — EXACT DEPENDENCY VALIDATION: the validator independently
// verifies derived marketContext clocks against the ACTUAL contributor set.
// Fixture clocks: the only candle source (TST) was retrieved at 2000s.
test('EXACT DEPENDENCY VALIDATION: contributor clocks are enforced in BOTH directions', () => {
  const CONTRIB_CLOCK = '1970-01-01T00:33:20.000Z'; // 2000s — the TST candle retrieval
  const exactMc = (over = {}) => ({
    source: 'cross-symbol closed bars, trailing only (exact contributors only)',
    sourceTs: 1000,
    availableTs: 1000,
    retrievedTs: CONTRIB_CLOCK,
    kind: 'historical',
    form: 'derived',
    sourceInputs: ['TST'],
    components: {
      btcRet: 'UNAVAILABLE',
      ethRet: 'UNAVAILABLE',
      universeMedianRet: { contributors: ['TST'], contributorCount: 1, eligibleCandidateCount: 2, retrievedTs: CONTRIB_CLOCK },
    },
    ...over,
  });
  const withMc = (mc) => (f) =>
    (f['observations.jsonl'] = jsonl([obsRow({ id: 1, provenance: { ...fullProvenance(), marketContext: mc } }), obsRow({ id: 2, eventId: 'e2' })]));

  // exact provenance validates cleanly
  const clean = makeStaging(withMc(exactMc()));
  assert.deepEqual(validateChildhood(clean).errors, []);

  const cases = [
    // FALSE LATENESS: envelope claims 2400s though the only actual contributor was retrieved at 2000s
    ['inherits a retrieval clock later than its actual contributors', exactMc({ retrievedTs: RETRIEVED })],
    // knew too soon: envelope predates its contributor
    ['claims retrieval before its latest actual contributor', exactMc({ retrievedTs: '1970-01-01T00:20:00.000Z' })],
    // a listed contributor with no source record is unresolvable
    [
      'lists contributor GHOST with no source record',
      exactMc({
        components: {
          btcRet: 'UNAVAILABLE',
          ethRet: 'UNAVAILABLE',
          universeMedianRet: { contributors: ['TST', 'GHOST'], contributorCount: 2, eligibleCandidateCount: 2, retrievedTs: CONTRIB_CLOCK },
        },
        sourceInputs: ['GHOST', 'TST'],
      }),
    ],
    // sourceInputs must be exactly the contributor union — no padding
    ['sourceInputs do not match the actual contributor set', exactMc({ sourceInputs: ['TST', 'ZZZ'] })],
    // metadata must be internally consistent
    [
      'contributorCount does not match its contributor list',
      exactMc({
        components: {
          btcRet: 'UNAVAILABLE',
          ethRet: 'UNAVAILABLE',
          universeMedianRet: { contributors: ['TST'], contributorCount: 3, eligibleCandidateCount: 5, retrievedTs: CONTRIB_CLOCK },
        },
      }),
    ],
    // a component clock that disagrees with its contributors' source records
    [
      'component universeMedianRet clock does not match its actual contributors',
      exactMc({
        components: {
          btcRet: 'UNAVAILABLE',
          ethRet: 'UNAVAILABLE',
          universeMedianRet: { contributors: ['TST'], contributorCount: 1, eligibleCandidateCount: 2, retrievedTs: '1970-01-01T00:40:00.000Z' },
        },
      }),
    ],
  ];
  for (const [needle, mc] of cases) {
    const dir = makeStaging(withMc(mc));
    const v = validateChildhood(dir);
    assert.equal(v.ok, false, `"${needle}" was not caught`);
    assert.ok(v.errors.some((e) => e.includes(needle)), `no error names "${needle}": ${JSON.stringify(v.errors)}`);
    const auth = makeAuthoritative();
    assert.equal(promoteStaging(dir, auth).promoted, false);
    assert.equal(existsSync(path.join(auth, 'marker.json')), true);
  }
});

// §19.20 SCHEMA CONTRACT — one authoritative schema, version-checked.
test('SCHEMA CONTRACT: the single authoritative B-0B schema version is enforced', () => {
  assert.equal(EXPECTED_SCHEMA_VERSION, 'childhood-observation-3-b0b');
  assert.equal(CHILDHOOD_VERSION, 'B0B.2A'); // the provenance-precision generation the manifest must report (B-0B.2A §13)
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
  assert.deepEqual(v2.stats, { observations: 2, outcomes: 2, governance: 1, incidents: 1, incidentOutcomes: 1 });
});
