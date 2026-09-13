// Constitutional pump-doctrine guard. Protects the permanent MISSION.md rule
// that a pump is not an automatic reject, so a future cleanup/rewrite can never
// silently restore "pump => throw away". Doctrine-only; reads the file and
// asserts the wording. (SURGICAL CONSTITUTIONAL PUMP-DOCTRINE CORRECTION §10)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MISSION = readFileSync(new URL('../doctrine/MISSION.md', import.meta.url), 'utf8');

test('MISSION-PUMP-1. the permanent constitutional pump rule is present', () => {
  assert.ok(MISSION.includes('We do not reject pumps.'), 'the permanent rule must exist verbatim');
  assert.ok(/remaining executable edge/.test(MISSION), 'the rule must speak of remaining executable edge');
  assert.ok(MISSION.includes('We do not reject pumps. We reject pump-like moves whose remaining executable edge has disappeared.'),
    'the full one-line constitutional rule must be intact');
});

test('MISSION-PUMP-2. the old dangerous "pump behavior => throw away" construction is absent', () => {
  // the pre-correction sequence listed bare "pump behavior" as an automatic-discard condition
  assert.ok(!/meaningless movement,\s*pump behavior,\s*terrible liquidity/.test(MISSION),
    'bare "pump behavior" must not sit in the automatic-discard list again');
  // only late-stage/exhausted pump with no remaining edge may be discarded
  assert.ok(/late-stage or exhausted\s+pump behavior with no remaining executable edge/.test(MISSION),
    'the discard condition must be the exhausted/no-edge qualifier, not "pump" alone');
});

test('MISSION-PUMP-3. early/expanding pump behavior is explicitly not disqualifying', () => {
  assert.ok(/[Ee]arly or expanding pump behavior is not disqualifying/.test(MISSION));
});

test('MISSION-PUMP-4. price extension is context, not an automatic veto', () => {
  assert.ok(/price extension is context, not an automatic veto/.test(MISSION),
    'the contextual-extension concept must be pinned');
  // and no hard percentage veto was introduced
  assert.ok(!/\+?\d+%\s*=\s*(reject|risky|too late|veto)/i.test(MISSION), 'no hard percentage veto may be encoded');
});
