// RESEARCH REFEREE — H. the authority firewall, proven structurally: the referee imports only pure research contracts
// and its own package; no production module imports the referee; no production path carries a referee verdict; the
// vocabulary carries no trading command; the referee is pure (no clock, no randomness, no environment, no network,
// no filesystem outside the two named modules); evaluating a strong synthetic "edge" leaves every runtime state
// untouched. Scanned over CODE lines, never over comments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VERDICTS, REASON_CODES, FORBIDDEN_TOKENS, AUTHORITY_STAMP, EXPERIMENT_STATUSES, REGISTRY_RECORD_KINDS, METRIC_NAMES, tokensOf, carriesForbiddenToken } from '../research/referee/contracts.js';
import { refereeSourceClosure, refereeCodeIdentity } from '../research/referee/seal.js';
import { pipelineSourceClosure } from '../research/identity.js';
import { refereeEvaluate } from '../research/referee/evaluate.js';
import { realEffectData, bundleFor } from './helpers/referee.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tracked = execSync("git ls-files -co --exclude-standard '*.js' '*.mjs' '*.cjs'", { cwd: REPO, encoding: 'utf8' }).trim().split('\n'); // tracked + untracked, so a new file is fenced before its first commit
const read = (f) => readFileSync(path.join(REPO, f), 'utf8');
const code = (f) => read(f).split('\n').filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); }).join('\n');
const importsOf = (f) => [...code(f).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).concat([...code(f).matchAll(/import\s*\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]));
const REFEREE = tracked.filter((f) => f.startsWith('research/referee/'));
const PRODUCTION_ROOTS = /^(judge|execution|watch|paper|socrates|market-lab|ui|bin|state|ledger|cost|rumor2|rumint|tape|gateway|governance|persistence|memory|childhood|survey|evidence|lib|cost)\//;
const IO_MODULES = ['research/referee/seal.js', 'research/referee/store.js'];

test('H1. import fences A + B: every referee module imports only node built-ins (crypto everywhere; fs / path / child_process only in seal.js and store.js), the pure research contracts / identity, and its own package — never Judge, execution, paper, live, orders, sizing, risk, venue clients, Socrates, Watch, the UI or a provider', () => {
  assert.ok(REFEREE.length >= 12, `referee files ${REFEREE.length}`);
  for (const f of REFEREE) {
    for (const i of importsOf(f)) {
      if (i.startsWith('node:')) { assert.ok(['node:crypto', 'node:fs', 'node:path', 'node:child_process', 'node:url'].includes(i), `${f}: ${i}`); if (i !== 'node:crypto') assert.ok(IO_MODULES.includes(f), `${f}: ${i} outside the two I/O modules`); continue; }
      assert.ok(i.startsWith('./') || i === '../contracts.js' || i === '../identity.js', `${f}: ${i} crosses the referee fence`);
      assert.ok(!/(judge|execution|watch|paper|socrates|market-lab|ui|bin|orders|risk|sizing|kraken|venue|provider|ledger|cost|state|persistence|rumor2|rumint|tape|gateway|fly|index)/.test(i), `${f}: ${i}`);
    }
    assert.ok(!/require\s*\(/.test(code(f)), `${f}: no require`);
  }
  const closure = refereeSourceClosure();
  assert.ok(closure.includes('research/referee/evaluate.js') && closure.includes('research/contracts.js') && closure.includes('research/identity.js'));
  // the referee adds NO reach of its own: everything it touches beyond its package is what the pre-existing (separately fenced) research contracts / identity already reached
  const inherited = new Set(pipelineSourceClosure(['research/contracts.js', 'research/identity.js'])); const own = closure.filter((f) => !inherited.has(f));
  for (const f of own) assert.ok(f.startsWith('research/referee/'), `the referee reaches ${f} on its own`); assert.ok(own.length >= 12);
  for (const f of closure) assert.ok(!/^(judge|execution|watch|paper|socrates|market-lab|ui|bin|state|ledger|cost|persistence|tape|gateway|fly\.js|index\.js)/.test(f), `closure reaches a production module: ${f}`);
});

test('H2. import fence C + D: no tracked module outside research/referee/ and test/ imports the referee, and no production path carries a referee verdict, status or record kind to branch on', () => {
  const outsiders = tracked.filter((f) => !f.startsWith('research/referee/') && !f.startsWith('test/'));
  for (const f of outsiders) for (const i of importsOf(f)) assert.ok(!/referee/.test(i), `${f} imports the referee (${i})`);
  const words = ['HISTORICALLY_INTERESTING', 'SUSPECT_MULTIPLE_TESTING', 'SUSPECT_FRAGILITY', 'PIT_VIOLATION', 'LEAKAGE_DETECTED', 'PROSPECTIVE_SUPPORTED', 'PROSPECTIVE_NOT_SUPPORTED', 'refereeEvaluate', 'RESEARCH_REFEREE', 'serpent-referee', 'serpent-research-referee']; assert.ok(EXPERIMENT_STATUSES.length && REGISTRY_RECORD_KINDS.length);
  for (const f of outsiders.filter((x) => !x.startsWith('research/'))) { const c = code(f); for (const w of words) assert.ok(!c.includes(w), `${f} carries the referee word ${w}`); }
  const production = tracked.filter((f) => PRODUCTION_ROOTS.test(f) || ['fly.js', 'index.js'].includes(f)); assert.ok(production.length >= 100, 'the production tree is actually scanned');
  for (const f of production) assert.ok(!/research\/referee/.test(read(f)), `${f} mentions the referee`);
});

test('H3. the vocabulary: no verdict, reason code, status, record kind, metric name or authority stamp field carries a trading command token; the stamp is exactly the research tier\'s words plus explicit false fields; a forbidden verdict cannot be sealed', () => {
  for (const v of [...VERDICTS, ...REASON_CODES, ...EXPERIMENT_STATUSES, ...REGISTRY_RECORD_KINDS, ...METRIC_NAMES]) assert.ok(!carriesForbiddenToken(v), v);
  assert.deepEqual(FORBIDDEN_TOKENS, ['BUY', 'SELL', 'LONG', 'SHORT', 'ENTER', 'EXIT', 'TRADE', 'EXECUTE', 'ELIGIBLE', 'APPROVED', 'SIZE', 'ALLOCATE']);
  assert.deepEqual(AUTHORITY_STAMP, { authority: 'NONE', purpose: 'RESEARCH_ONLY', researchOnly: true, canAffectTrading: false, canAffectEligibility: false, canAffectSizing: false, canAffectExecution: false }); assert.ok(Object.isFrozen(AUTHORITY_STAMP));
  assert.ok(carriesForbiddenToken('APPROVED_FOR_TRADING') && carriesForbiddenToken('BUY') && !carriesForbiddenToken('SAMPLE_COUNT') && !carriesForbiddenToken('SHORTFALL_X'), 'tokens, not substrings');
  assert.deepEqual(tokensOf('A_B-C'), ['A', 'B', 'C']);
  // every reason code the source emits is in the closed list
  const emitted = new Set(); for (const f of REFEREE) for (const m of code(f).matchAll(/(?:finding|bad|add|hit|flags\.push|reasons\.push|mt\.push|mtReject\.push|fr\.push|warnings\.push|seal\([^)]*\[)\(?'([A-Z][A-Z0-9_]+)'/g)) emitted.add(m[1]);
  for (const r of emitted) assert.ok(REASON_CODES.includes(r) || VERDICTS.includes(r) || ['PURGED', 'EMBARGOED', 'NEIGHBOR', 'LEAVE_ONE_BLOCK_OUT', 'LEAVE_ONE_SYMBOL_OUT', 'EARLY_HALF', 'LATE_HALF', 'REGIME', 'DAY_OF_WEEK', 'INTERNAL_FAILURE', 'INVALID_REQUEST', 'RESOURCE_LIMIT_EXCEEDED', 'CORRUPT_INPUT', 'VALIDATION_FAILURE', 'OUTPUT_EXISTS'].includes(r), `emitted code ${r} is not in the closed list`);
  const src = code('research/referee/evaluate.js'); assert.ok(src.includes("throw new Error('forbidden vocabulary')"));
});

test('H4. purity: no referee module reads a clock, Math.random, the environment, a timer, the network or a socket; only seal.js and store.js touch the filesystem / git; the seeded generator is the only randomness', () => {
  for (const f of REFEREE) {
    const c = code(f);
    for (const bad of ['Date.now', 'new Date(', 'Math.random', 'process.env', 'setTimeout', 'setInterval', 'fetch(', 'node:http', 'node:https', 'node:net', 'WebSocket', 'process.exit', 'console.log']) assert.ok(!c.includes(bad), `${f}: ${bad}`);
    if (!IO_MODULES.includes(f)) for (const bad of ['readFileSync', 'writeFileSync', 'openSync', 'execFileSync', 'execSync', 'spawn']) assert.ok(!c.includes(bad), `${f}: ${bad}`);
  }
  assert.ok(code('research/referee/contracts.js').includes('xoshiro128**') || read('research/referee/contracts.js').includes('xoshiro128**'));
  const id = refereeCodeIdentity(); assert.match(id.sourceTreeSha256, /^[0-9a-f]{64}$/); assert.ok(['PRODUCED_BY_COMMITTED_SOURCE', 'PRODUCED_BY_UNCOMMITTED_SOURCE', 'SOURCE_CLEANLINESS_UNKNOWN', 'NO_GIT_CHECKOUT'].includes(id.law)); assert.ok(id.sourceFiles >= 12);
});

test('H5. a strong synthetic "edge" evaluated to HISTORICALLY_INTERESTING changes nothing: no file appears under the data directory, no execution journal event is written, the report is frozen and carries no function; the referee never imports the paper / Judge / Watch modules that hold that state', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'referee-state-')); const prevData = process.env.COBRA_DATA_DIR; process.env.COBRA_DATA_DIR = dir;
  try {
    const { createMemoryJournal } = await import('../execution/journal.js'); const journal = createMemoryJournal(); const before = await journal.load('paper-fence'); const beforeSeq = before?.headSeq ?? 0;
    const walk = (d) => { let out = []; for (const f of readdirSync(d)) { const full = path.join(d, f); if (statSync(full).isDirectory()) out = out.concat(walk(full)); else out.push(full); } return out; };
    const { bundle } = bundleFor({ data: realEffectData('state') }); const r = refereeEvaluate(bundle); assert.equal(r.verdict.verdict, 'HISTORICALLY_INTERESTING');
    assert.deepEqual(walk(dir), [], 'nothing written under the data dir'); const after = await journal.load('paper-fence'); assert.equal(after?.headSeq ?? 0, beforeSeq, 'no journal event');
    const hasFn = (v) => (typeof v === 'function' ? true : v && typeof v === 'object' ? Object.values(v).some(hasFn) : false); assert.equal(hasFn(r), false); assert.ok(Object.isFrozen(r.verdict)); assert.throws(() => { r.verdict.verdict = 'BUY'; }, 'frozen');
    const closure = refereeSourceClosure(); for (const f of closure) assert.ok(!/^(paper|judge|watch|execution)\//.test(f), f);
  } finally { if (prevData === undefined) delete process.env.COBRA_DATA_DIR; else process.env.COBRA_DATA_DIR = prevData; rmSync(dir, { recursive: true, force: true }); }
});

test('H6. package hygiene: no new dependency, no package.json change, the doctrine document exists and states the zero-authority law, and the referee doctrine carries no trading command as a verdict', () => {
  const pkg = JSON.parse(read('package.json')); assert.deepEqual(Object.keys(pkg.dependencies), ['pg']); assert.ok(!('referee' in (pkg.scripts ?? {})));
  const doc = read('doctrine/REFEREE.md'); for (const must of ['zero trading authority', 'falsify', 'trial history is permanent', 'purg', 'embargo', 'CPCV', 'PBO', 'PSR', 'DSR', 'not production approval', 'prospective', 'INTERIM', 'reproduce', 'INVALID_INPUT', 'PIT_VIOLATION', 'LEAKAGE_DETECTED', 'HISTORICALLY_INTERESTING']) assert.ok(doc.toLowerCase().includes(must.toLowerCase()), `doctrine lacks: ${must}`);
  assert.ok(!/\b(APPROVED_FOR_TRADING|ELIGIBLE_FOR_TRADING)\b/.test(doc));
});
