// PAPER-FLIP-PREP (d) — the composition diff between the PAPER trading root and the DATA-ONLY root,
// enumerated and fenced from BOTH sides. The paper flip is exactly "compose the decision + supervision +
// execution tiers on top of the same observation spine"; this pins which tiers are PAPER-only so a future
// change can neither drop a tier from the paper composition nor leak one into the data-only process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRADING_COMPOSITION_ROOT, DATA_ONLY_COMPOSITION_ROOT } from './helpers/composition-roots.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The PAPER-only tiers: the decision engine, its execution journal / adapters, and post-entry supervision.
// DATA-ONLY composes none of them (observation only); the paper composition composes all of them.
const PAPER_ONLY_TIERS = Object.freeze(['judge', 'execution', 'watch']);

// A static relative-import walker (mirrors the data-only import-graph fence). It follows `import ... from`
// and `import(...)` specifiers that resolve to repo files, so both static and the dynamic imports the
// trading root uses (`await import('./judge/composition.js')`) are traversed.
const SPEC_RE = /(?:import\s+[^'"]*from\s*|import\s*\(\s*|export\s+[^'"]*from\s*)['"]([^'"]+)['"]/g;
function importGraph(entryRel) {
  const seen = new Set();
  const walk = (fileRel) => {
    if (seen.has(fileRel)) return; seen.add(fileRel);
    const abs = path.join(REPO, fileRel);
    if (!existsSync(abs)) return;
    const src = readFileSync(abs, 'utf8');
    for (const m of src.matchAll(SPEC_RE)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue; // node builtins / packages are not composition tiers
      let next = path.relative(REPO, path.resolve(path.dirname(abs), spec)).replace(/\\/g, '/');
      if (!/\.[mc]?js$/.test(next)) next = `${next}.js`;
      walk(next);
    }
  };
  walk(entryRel);
  return seen;
}

const tierOf = (rel) => rel.split('/')[0];

test('DATA-ONLY composition composes none of the PAPER-only tiers (Judge / execution / Watch)', () => {
  const graph = importGraph(DATA_ONLY_COMPOSITION_ROOT);
  const tiers = new Set([...graph].map(tierOf));
  for (const tier of PAPER_ONLY_TIERS) assert.equal(tiers.has(tier), false, `data-only root must not compose the ${tier}/ tier`);
});

test('the PAPER composition composes every PAPER-only tier (Judge / execution / Watch) — the flip adds exactly these on top of the observation spine', () => {
  // The trading root reaches the tiers through judge/composition.js (dynamic import at boot); walking from
  // the trading root traverses that edge, so all three PAPER-only tiers must appear.
  const graph = importGraph(TRADING_COMPOSITION_ROOT);
  const tiers = new Set([...graph].map(tierOf));
  for (const tier of PAPER_ONLY_TIERS) assert.equal(tiers.has(tier), true, `the paper composition must compose the ${tier}/ tier`);
  // and the specific spine seams the paper flip depends on are present
  assert.ok(graph.has('judge/composition.js'), 'the Judge composition module');
  assert.ok(graph.has('execution/journal.js'), 'the execution journal (the writer-fenced authority)');
  assert.ok(graph.has('watch/watch.js'), 'the Watch (post-entry supervision)');
});

test('the diff is asymmetric: every PAPER-only tier is in the paper graph and in NEITHER the data-only graph', () => {
  const paper = new Set([...importGraph(TRADING_COMPOSITION_ROOT)].map(tierOf));
  const dataOnly = new Set([...importGraph(DATA_ONLY_COMPOSITION_ROOT)].map(tierOf));
  for (const tier of PAPER_ONLY_TIERS) {
    assert.ok(paper.has(tier) && !dataOnly.has(tier), `${tier}/ is PAPER-only: present in the trading composition, absent from data-only`);
  }
  // both compose the shared observation spine (the market-lab research owner + the runtime spine)
  assert.ok(paper.has('market-lab') && dataOnly.has('market-lab'), 'both compose the market-lab observation tier');
  assert.ok(paper.has('lib') && dataOnly.has('lib'), 'both compose the shared runtime spine (lib/)');
});
