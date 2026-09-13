// ADDENDUM-2 §13 / FINAL SIZING ADDENDUM — structural fences for the integrity, diagnostic and sizing modules.
// These are laws, not conventions: the diagnostic harness can never reach the Judge or the network; the neutral
// integrity contracts import nothing operational; the size ladder consumes ONLY the existing cost law and money
// arithmetic; and no new module opens a network primitive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(path.join(root, p), 'utf8');
const importsOf = (text) => [...text.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gms)].map((m) => m[1]);

test('the neutral integrity contract is pure: learning/model-integrity.js imports only learning/contracts.js — no judge, no research, no operational modules, no node builtins', () => {
  assert.deepEqual(importsOf(src('learning/model-integrity.js')), ['./contracts.js']);
});

test('memory views, masking and the sizing study stay inside learning/: no imports outside the learning package', () => {
  for (const f of ['learning/memory-view.js', 'learning/masking.js', 'learning/sizing-study.js', 'learning/diagnostic.js']) {
    for (const imp of importsOf(src(f))) {
      assert.ok(imp.startsWith('./'), `${f} imports ${imp} — new integrity modules import only sibling learning modules`);
      assert.ok(!imp.includes('judge') && !imp.includes('research') && !imp.includes('execution'), `${f} must not reach ${imp}`);
    }
  }
});

test('the diagnostic harness can NEVER call the network or the Judge: no node:http(s), net, tls, dns, fetch or judge/ reference in the diagnostic or masking modules — the transport is injected and budget-bounded', () => {
  for (const f of ['learning/diagnostic.js', 'learning/masking.js', 'learning/model-integrity.js', 'learning/memory-view.js', 'learning/sizing-study.js']) {
    const text = src(f);
    assert.ok(!/node:https?|node:net|node:tls|node:dns|\bfetch\s*\(/.test(text), `${f} must not contain a network primitive`);
    assert.ok(!/from\s+['"][^'"]*judge/.test(text), `${f} must not import from judge/`);
  }
});

test('the size ladder consumes ONLY the existing cost law and money arithmetic: judge/size-ladder.js imports exactly ../execution/money.js and ./cost.js — the unchanged sizeSearch is the sole executable-cost authority', () => {
  assert.deepEqual(importsOf(src('judge/size-ladder.js')).sort(), ['../execution/money.js', './cost.js'].sort());
});

test('the two consumer switches are ports, not imports: judge/judge.js takes learning and dynamicSizing as null-default parameters, and the composition root (fly.js) passes NEITHER — both influences are structurally dormant in the running host', () => {
  const judge = src('judge/judge.js');
  assert.match(judge, /learning = null/, 'the learned-selection port defaults off');
  assert.match(judge, /dynamicSizing = null/, 'the dynamic-sizing port defaults off');
  const fly = src('fly.js');
  assert.ok(!fly.includes('learningActivationSource'), 'fly.js never wires the learned-selection port');
  assert.ok(!fly.includes('dynamicSizing'), 'fly.js never wires the dynamic-sizing port');
});

test('no learning module writes to the Judge, Watch, execution journal, controls, or config: the learning package only ever reads foreign artifacts through its own store and archive reader', () => {
  const files = ['contracts.js', 'store.js', 'labels.js', 'features.js', 'capture.js', 'maturation.js', 'grouping.js', 'estimator.js', 'patterns.js', 'prospective.js', 'adapter.js', 'promotion.js', 'campaign.js', 'continuous.js', 'questions.js', 'summary.js', 'service.js', 'commands.js', 'source-delay.js', 'model-integrity.js', 'memory-view.js', 'masking.js', 'diagnostic.js', 'sizing-study.js'];
  for (const f of files) {
    for (const imp of importsOf(src(path.join('learning', f)))) {
      const outside = imp.startsWith('../');
      if (!outside) continue;
      assert.ok(imp.startsWith('../lib/'), `learning/${f} imports ${imp} — only lib/ utilities may be imported from outside learning/`);
    }
  }
});
