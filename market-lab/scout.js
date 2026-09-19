// SOCRATES SCOUT (PUBLISH-FIX-74, 2026-09-18). David: "can Socrates also scan coins to suggest something… bring it to the
// Judge's attention and say hey look at this, I found this, do you like it?" and "if Socrates sees something [while the
// Judge is full], push an audible to him and say hey you need to look at this, it's time sensitive."
//
// What this is: a bounded NOMINATION source, the same door the volatility watch and the learned re-look use. It reads the
// research service's SEALED cases (the ones Socrates wrote, verified byte-for-byte by the injected verifier — never a raw
// model reply) and, when a fresh LIVE_MODEL case names UPWARD_PRESSURE on a coin, it calls an AUDIBLE: the coin is nominated
// into the Judge's preparation slots with the case's completion minute as its nomination clock. The Judge's nomination law
// gives a slot to the newest nomination, so a fresh audible takes a slot even when the six are full — that is the push. It
// is time-boxed (windowMin) and capped (maxAudibles at once, maxPerHour called), one call per case, newest case per coin.
//
// What this is NOT: Socrates never the wheel. An audible changes WHAT THE JUDGE WATCHES and nothing else — every setup,
// gate, cost and risk rule decides the entry exactly as before, and the CATALYST_TRANSMISSION setup still consumes the
// case through the Judge's own intake. Dormant by nature until Socrates is funded (no case → no audible), and it says so.
// Authority NONE; fail-closed: a torn case directory or a throwing verifier is counted and skipped, never propagated.
import path from 'node:path';
import { readdirSync, existsSync, statSync } from 'node:fs';

export const SCOUT_VERSION = 'socrates-scout-1';
export const SCOUT_SOURCE = 'SOCRATES_SCOUT';
export const SCOUT_DEFAULTS = Object.freeze({ windowMin: 60, maxAudibles: 2, maxPerHour: 4, lookbackMin: 90, maxDirs: 256, direction: 'UPWARD_PRESSURE', provenance: 'LIVE_MODEL' });
const MIN = 60_000; const HOUR = 60 * MIN;
const CASE_DIR_RE = /^[A-Za-z0-9._-]{1,120}$/;
const bounded = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const hhmm = (ts) => new Date(ts).toISOString().slice(11, 16);

// pure: which findings are audibles right now. `findings` are consumed cases {dir, coin, ok, direction, provenance,
// completionTs, note}; `called` is the scout's own memory of audibles already called {dir, coin, calledTs, note}.
// Returns the active audibles (called, still inside their window) and the NEW calls to make this pass, under the caps.
export function selectAudibles(findings, called, { nowTs, windowMin = SCOUT_DEFAULTS.windowMin, maxAudibles = SCOUT_DEFAULTS.maxAudibles, maxPerHour = SCOUT_DEFAULTS.maxPerHour, lookbackMin = SCOUT_DEFAULTS.lookbackMin, direction = SCOUT_DEFAULTS.direction, provenance = SCOUT_DEFAULTS.provenance } = {}) {
  const active = called.filter((a) => a.calledTs + windowMin * MIN > nowTs).sort((a, b) => b.calledTs - a.calledTs);
  const activeCoins = new Set(active.map((a) => a.coin)); const calledDirs = new Set(called.map((a) => a.dir));
  let calledLastHour = called.filter((a) => nowTs - a.calledTs < HOUR).length;
  const fresh = findings
    .filter((f) => f && f.ok && f.direction === direction && f.provenance === provenance && Number.isSafeInteger(f.completionTs) && f.completionTs <= nowTs && nowTs - f.completionTs <= lookbackMin * MIN && typeof f.coin === 'string' && f.coin.length && !calledDirs.has(f.dir))
    .sort((a, b) => b.completionTs - a.completionTs);
  const calls = []; const seen = new Set();
  for (const f of fresh) {
    if (seen.has(f.coin) || activeCoins.has(f.coin)) continue; // newest case per coin; a coin already under an audible is not re-called
    if (active.length + calls.length >= maxAudibles) break;
    if (calledLastHour >= maxPerHour) break;
    seen.add(f.coin); calledLastHour += 1;
    calls.push({ dir: f.dir, coin: f.coin, calledTs: nowTs, caseCompletionTs: f.completionTs, note: bounded(f.note), untilTs: nowTs + windowMin * MIN });
  }
  return { active: [...calls, ...active].map((a) => ({ ...a, untilTs: a.untilTs ?? a.calledTs + windowMin * MIN })), calls, capped: { atOnce: active.length + calls.length >= maxAudibles && fresh.length > calls.length, perHour: calledLastHour >= maxPerHour && fresh.length > calls.length } };
}

export function createScoutSource({ casesDir, verify, consume, clock = () => Date.now(), log = () => {}, options = {} } = {}) {
  const cfg = { ...SCOUT_DEFAULTS, ...options };
  const seen = new Map(); // dir -> { mtimeMs, finding }
  const called = []; // audibles ever called this instance (bounded)
  const counters = { scans: 0, casesSeen: 0, verifyFailures: 0, refused: 0, audibles: 0, cappedAtOnce: 0, cappedPerHour: 0 };
  let current = { active: [], lastScanTs: null, reason: 'NO_CASES_YET' };
  function dirs() { try { return readdirSync(casesDir).filter((d) => CASE_DIR_RE.test(d) && existsSync(path.join(casesDir, d, 'manifest.json'))).sort().slice(-cfg.maxDirs); } catch { return []; } }
  async function readFinding(d, nowTs) {
    const dir = path.join(casesDir, d);
    let verified; try { verified = await verify(dir); } catch (err) { counters.verifyFailures += 1; return { dir: d, ok: false, reasons: [`VERIFY_THREW:${bounded(err?.message, 60)}`] }; }
    if (!verified?.ok) { counters.verifyFailures += 1; return { dir: d, ok: false, reasons: (verified?.reasons ?? ['VERIFY_FAILED']).slice(0, 3) }; }
    const coin = verified.manifest?.subject?.canonicalCoin ?? null;
    let c; try { c = consume(verified, { canonicalCoin: coin, decisionTs: nowTs, requireContext: false }); } catch (err) { counters.refused += 1; return { dir: d, coin, ok: false, reasons: [`CONSUME_THREW:${bounded(err?.message, 60)}`] }; }
    if (!c?.ok) { counters.refused += 1; return { dir: d, coin, ok: false, reasons: (c?.reasons ?? ['CONSUME_REFUSED']).slice(0, 3) }; }
    return { dir: d, coin, ok: true, direction: c.direction ?? null, provenance: c.provenance ?? null, completionTs: c.completionTs ?? null, horizon: c.analysis?.marketImplication?.horizon ?? null, note: c.analysis?.thesis?.text ?? '' };
  }
  async function refresh(nowTs = clock()) {
    counters.scans += 1;
    for (const d of dirs()) {
      let m; try { m = statSync(path.join(casesDir, d, 'manifest.json')).mtimeMs; } catch { continue; }
      const prev = seen.get(d); if (prev && prev.mtimeMs === m) continue;
      if (!prev) counters.casesSeen += 1;
      seen.set(d, { mtimeMs: m, finding: await readFinding(d, nowTs) });
    }
    const findings = [...seen.values()].map((e) => e.finding);
    const sel = selectAudibles(findings, called, { ...cfg, nowTs });
    for (const a of sel.calls) { called.push(a); counters.audibles += 1; log(`SOCRATES SCOUT: audible — ${a.coin} into the Judge's watch until ${hhmm(a.untilTs)} UTC: Socrates' ${hhmm(a.caseCompletionTs)} case reads UPWARD_PRESSURE${a.note ? ` — "${a.note}"` : ''} (case ${a.dir}); the Judge's setups and gates decide the entry as always`); }
    if (called.length > 256) called.splice(0, called.length - 256);
    if (sel.capped.atOnce) counters.cappedAtOnce += 1; if (sel.capped.perHour) counters.cappedPerHour += 1;
    current = { active: sel.active, lastScanTs: nowTs, reason: findings.length === 0 ? 'NO_CASES_YET' : sel.active.length ? 'AUDIBLE' : 'NO_FRESH_UPWARD_CASE' };
    return current;
  }
  const nominations = (nowTs = clock()) => current.active.filter((a) => a.untilTs > nowTs).map((a) => ({ symbol: `${a.coin}/USD`, assetId: a.coin, source: SCOUT_SOURCE, nominationKnownAtTs: a.calledTs }));
  const line = () => `SOCRATES SCOUT: ${current.active.length ? current.active.map((a) => `${a.coin} until ${hhmm(a.untilTs)} (${a.note ? a.note.slice(0, 60) : 'upward case'})`).join('; ') : current.reason === 'NO_CASES_YET' ? 'no sealed case to read yet (dormant until Socrates is funded)' : 'no fresh upward case; no audible'} — ${counters.casesSeen} cases seen, ${counters.audibles} audibles called (caps ${cfg.maxAudibles} at once / ${cfg.maxPerHour} per hour)`;
  return { version: SCOUT_VERSION, refresh, nominations, line, current: () => current, status: () => ({ version: SCOUT_VERSION, casesDir, active: current.active.slice(), lastScanTs: current.lastScanTs, counters: { ...counters }, config: { ...cfg }, authority: 'NONE' }) };
}
