// LEARN-1 — the authority fences, proven from source: no learning module reaches execution, orders, The Watch,
// the tape, providers or the referee; the runtime wiring is opt-in; no closed vocabulary carries a trading verb.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as contracts from '../learning/contracts.js';

const LEARNING_DIR = path.join(process.cwd(), 'learning');
const FORBIDDEN_IMPORTS = ["'../execution", "'../judge", "'../watch", "'../tape", "'../socrates", "'../rumor2", "'../market-lab", "'../rumint", "'../gateway", "'../press", "'../infra", "'../video", "'../persistence", "'../research/referee", "'../state", "'../ledger", "'../cost"];
const FORBIDDEN_RUNTIME = ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'WebSocket', 'fetch(', 'child_process'];

test('every learning module imports only lib/, research pure modules and its own package — never execution, judge, watch, tape, providers, persistence or the referee', () => {
  for (const f of readdirSync(LEARNING_DIR).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(path.join(LEARNING_DIR, f), 'utf8');
    for (const forbidden of FORBIDDEN_IMPORTS) assert.ok(!src.includes(`from ${forbidden}`), `${f} imports ${forbidden}`);
    for (const forbidden of FORBIDDEN_RUNTIME) assert.ok(!src.includes(forbidden), `${f} contains ${forbidden}`);
  }
});

test('the only cross-package imports are the label recipe, the archive reader and lib/ helpers (reuse, not duplication)', () => {
  const allowed = new Set(["'../research/outcomes.js'", "'../research/contracts.js'", "'../research/archive.js'", "'../lib/jsonl.js'", "'../lib/config.js'"]);
  for (const f of readdirSync(LEARNING_DIR).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(path.join(LEARNING_DIR, f), 'utf8');
    for (const m of src.matchAll(/from ('\.\.\/[^']+')/g)) assert.ok(allowed.has(m[1]), `${f} imports ${m[1]} which is not in the allowed reuse set`);
  }
});

test('no closed learning vocabulary carries a trading token', () => {
  const vocab = [
    ...contracts.PATTERN_STATES, ...contracts.DECISION_KINDS, ...contracts.REJECTION_CLASSES, ...contracts.OUTCOME_CLASSES,
    ...contracts.COUNTERFACTUAL_STATES, ...contracts.ATTENTION_CLASSES, ...contracts.SIM_MODES, ...contracts.FIDELITIES,
    ...contracts.EVIDENCE_BASES, ...contracts.QUESTION_FAMILIES, ...contracts.QUESTION_STATES, ...contracts.ACTIVATION_STATES,
    ...contracts.CAMPAIGN_STATES,
  ];
  for (const token of ['BUY', 'SELL', 'LONG', 'SHORT', 'ENTER', 'EXECUTE', 'STRIKE', 'ALLOCATE', 'LEVERAGE']) {
    for (const word of vocab) assert.ok(!word.split('_').includes(token), `vocabulary word ${word} carries ${token}`);
  }
});

test('runtime wiring is opt-in: fly.js gates LEARN-1 on LEARNING_ENABLED and uses dynamic import; bin/cobra.js lazy-imports the commands', () => {
  const fly = readFileSync(path.join(process.cwd(), 'fly.js'), 'utf8');
  assert.ok(fly.includes("process.env.LEARNING_ENABLED === 'true'"));
  assert.ok(fly.includes("import('./learning/service.js')"));
  const cobra = readFileSync(path.join(process.cwd(), 'bin', 'cobra.js'), 'utf8');
  assert.ok(cobra.includes("import('../learning/commands.js')"));
});

test('the adapter is NOT wired into the judge or paper composition (the declared boundary stays dormant while paper is off)', () => {
  for (const dir of ['judge', 'paper', 'execution', 'watch']) {
    for (const f of readdirSync(path.join(process.cwd(), dir)).filter((x) => x.endsWith('.js'))) {
      const src = readFileSync(path.join(process.cwd(), dir, f), 'utf8');
      assert.ok(!src.includes('learning/'), `${dir}/${f} must not reference learning/ in this ticket`);
    }
  }
});

test('activation authority is exactly the one bounded paper adjustment; everything else is authority NONE', () => {
  assert.equal(contracts.AUTHORITY, 'NONE');
  assert.equal(contracts.AUTHORITY_PAPER_ADJUSTMENT, 'PAPER_ASSESSMENT_ADJUSTMENT_ONLY');
  assert.ok(contracts.ADJUSTMENT_CEILINGS.maxAbsPerActivation <= 0.15);
  assert.ok(contracts.ADJUSTMENT_CEILINGS.maxAbsAggregate <= 0.25);
});
