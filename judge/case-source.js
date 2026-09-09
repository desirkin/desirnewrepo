// JUDGE — the read-only sealed-case accessor (ticket §4.1 / §9.1): Judge consumes COMPLETED research cases from the
// research service's case directories through the shared verifier (bytes + verifier-version cache, recomputed context
// resolution) and the intake consumer (subject, clocks, age, provenance). Research remains the producer: nothing here
// enqueues, edits or deletes a case, and a live runtime refuses RECORDED_RESPONSE provenance as operational evidence.
import { readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { createCaseVerifier, consumeCase } from './intake.js';

const CASE_DIR_RE = /^[A-Za-z0-9._-]{1,120}$/;
export function createCaseSource({ casesDir, clock, mode = 'PAPER', maxDirs = 256, worker = null, log = () => {} }) {
  const verifier = createCaseVerifier({ clock, worker }); const consumed = new Map(); // dir -> { mtimeMs, verified }
  function candidates() { try { return readdirSync(casesDir).filter((d) => CASE_DIR_RE.test(d) && existsSync(path.join(casesDir, d, 'manifest.json'))).sort().slice(-maxDirs); } catch { return []; } }
  async function refresh() { for (const d of candidates()) { const dir = path.join(casesDir, d); let m; try { m = statSync(path.join(dir, 'manifest.json')).mtimeMs; } catch { continue; } const prev = consumed.get(d); if (prev && prev.mtimeMs === m) continue; try { consumed.set(d, { mtimeMs: m, verified: await verifier.verify(dir) }); } catch (err) { log(`case ${d}: verify failed: ${err.message}`); consumed.set(d, { mtimeMs: m, verified: { ok: false, reasons: ['VERIFY_THREW'] } }); } } }
  // the freshest admissible case for one subject at one decision clock (null when none qualifies; reasons are kept for status)
  function consumedFor(canonicalCoin, decisionTs, { requireContext = true } = {}) {
    let best = null; const refused = [];
    for (const [d, e] of consumed) { if (!e.verified?.ok) continue; const c = consumeCase(e.verified, { canonicalCoin, decisionTs, requireContext }); if (!c.ok) { refused.push({ dir: d, reasons: c.reasons.slice(0, 4) }); continue; } if (mode !== 'REPLAY' && c.provenance !== 'LIVE_MODEL') { refused.push({ dir: d, reasons: ['SYNTHETIC_PROVENANCE_REFUSED'] }); continue; } if (!best || c.completionTs > best.completionTs) best = { ...c, dir: d }; }
    return best ? { case: best, refused } : { case: null, refused: refused.slice(-8) };
  }
  return { refresh, consumed: (coin, { decisionTs, requireContext = true } = {}) => consumedFor(coin, decisionTs, { requireContext }).case, status: () => ({ casesDir, known: consumed.size, verified: [...consumed.values()].filter((e) => e.verified?.ok).length }), detail: consumedFor };
}
