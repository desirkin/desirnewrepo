// lib/learned-selection-state.js — PUBLISH-FIX-14 (2026-09-17, independent review F5): the cockpit's learned-selection
// switch reports the LIVE wiring of this process, never a constant. fly.js composes the decision-memory port for a PAPER
// Judge under SERPENT_LEARNING_RANKING; the learned-influence kill file (`cobra learning kill`) is the baseline arm.
export function learnedSelectionState(store, { env = process.env, run = null } = {}) {
  if (env.SERPENT_LEARNING_RANKING !== 'true') return 'OFF_NOT_ENABLED';
  if (!run || run.kind !== 'PAPER') return 'OFF_NO_PAPER_JUDGE';
  const snap = typeof run.learningSnapshotStatus === 'function' ? run.learningSnapshotStatus() : null;
  if (!snap) return 'OFF_NOT_WIRED';
  let kill = 'ARMED'; try { kill = store.readKill().state; } catch { kill = 'UNREADABLE'; }
  if (kill !== 'ARMED') return `ON_RANKING_ONLY_BASELINE_ARM (learned influence ${kill})`;
  return snap.preparedTs ? `ON_RANKING_ONLY (snapshot prepared ${new Date(snap.preparedTs).toISOString()})` : `ON_RANKING_ONLY_WAITING (${snap.lastError ?? 'no snapshot yet'})`;
}
