// lib/latch-clear-at-boot.js — PUBLISH-FIX-75 (2026-09-19): the KILL / CAGE latches cleared at boot under owner intent.
//
// Why: the CAGE latch (no new entries) had stood since 2026-09-11 in the PRODUCTION control plane. The cockpit CLEAR is
// the human door, but the owner could not get through it from the phone, and no shell reaches production (PUBLISH-FIX-7
// solved the same shape for the paper account). So, exactly like SERPENT_PAPER_INIT_ACCOUNT, the owner expresses the
// CLEAR through the environment:
//   SERPENT_CLEAR_LATCHES_AT_BOOT = true      (the intent; any other value is ignored)
//   SERPENT_CONTROL_PASSWORD      = present   (the owner secret that already guards every control door)
// With both present and JUDGE_MODE=PAPER, the paper boot runs the EXACT cockpit CLEAR path — persistence/control-plane.js
// requestClear: durable decision first, fingerprinted two-phase local drop, a restriction that lands meanwhile wins —
// before the Judge composes, so the Judge boots uncaged. Vetoes are never touched (a denied trade stays denied).
// Bounded retries carry it through a republish overlap (PERSISTENCE_BOOTING / PERSISTENCE_PERMISSION_LOCK are timing,
// not a refusal). No latch active -> nothing to do, said plainly. The variable keeps clearing on every boot while it is
// set: the log line tells the owner to remove it once it has done its job. The password is never logged, never echoed.
export const CLEAR_LATCHES_ENV = 'SERPENT_CLEAR_LATCHES_AT_BOOT';
export const CLEAR_RETRIES = 8;
export const CLEAR_RETRY_MS = 15_000;
const RETRY_REASONS = new Set(['PERSISTENCE_BOOTING', 'PERSISTENCE_PERMISSION_LOCK']);

export async function clearLatchesAtBoot({ env = process.env, log = () => {}, readControls, requestClear, retries = CLEAR_RETRIES, retryMs = CLEAR_RETRY_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const wanted = typeof env[CLEAR_LATCHES_ENV] === 'string' ? env[CLEAR_LATCHES_ENV].trim().toLowerCase() : '';
  if (!wanted) return { outcome: 'SKIPPED', reason: `${CLEAR_LATCHES_ENV} unset` };
  if (wanted !== 'true') { log(`CONTROL: latch clear at boot ignored: ${CLEAR_LATCHES_ENV} must be exactly true`); return { outcome: 'SKIPPED', reason: 'value is not true' }; }
  if (env.JUDGE_MODE !== 'PAPER') { log(`CONTROL: latch clear at boot refused: JUDGE_MODE ${env.JUDGE_MODE ?? 'unset'} is not PAPER`); return { outcome: 'REFUSED', reason: 'JUDGE_MODE is not PAPER' }; }
  if (typeof env.SERPENT_CONTROL_PASSWORD !== 'string' || !env.SERPENT_CONTROL_PASSWORD.length) {
    log('CONTROL: latch clear at boot refused: SERPENT_CONTROL_PASSWORD absent (owner intent needs the control password)');
    return { outcome: 'REFUSED', reason: 'SERPENT_CONTROL_PASSWORD absent' };
  }
  let c; try { c = readControls(); } catch (err) { log(`CONTROL: latch clear at boot refused: controls unreadable (${String(err?.message ?? err).slice(0, 120)})`); return { outcome: 'REFUSED', reason: 'controls unreadable' }; }
  const latched = [c?.kill?.active ? 'KILL' : null, c?.cage?.active ? 'CAGE' : null].filter(Boolean);
  if (!latched.length) { log(`CONTROL: no latch to clear at boot (${CLEAR_LATCHES_ENV} is set — remove it; it clears again on every boot while set)`); return { outcome: 'NOTHING_TO_CLEAR' }; }
  const since = c?.cage?.ts ?? c?.kill?.ts ?? null;
  for (let attempt = 1; ; attempt += 1) {
    let r; try { r = await requestClear({ source: 'boot-owner-intent' }); } catch (err) { r = { ok: false, reason: `THREW:${String(err?.message ?? err).slice(0, 80)}` }; }
    if (r?.ok) {
      log(`CONTROL: ${latched.join('+')} cleared at boot under owner intent (${CLEAR_LATCHES_ENV} + the control password)${since ? `; the latch had stood since ${since}` : ''}; mode ${r.mode ?? '?'}${attempt > 1 ? ` (after ${attempt} attempts)` : ''} — remove ${CLEAR_LATCHES_ENV} once it has done its job; it clears again on every boot while set`);
      return { outcome: 'CLEARED', latched, attempts: attempt, mode: r.mode ?? null };
    }
    if (RETRY_REASONS.has(r?.reason) && attempt < retries) { log(`CONTROL: latch clear at boot waiting (${r.reason}; attempt ${attempt} of ${retries})`); await sleep(retryMs); continue; }
    log(`CONTROL: latch clear at boot FAILED: ${r?.reason ?? 'unknown'} — the ${latched.join('+')} latch stands${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`);
    return { outcome: 'FAILED', reason: r?.reason ?? 'unknown', latched, attempts: attempt };
  }
}
