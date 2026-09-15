// SENSES -> CASE trigger (Ticket 6, 2026-09-15). The one missing seam of "senses -> case -> Socrates -> Judge": today
// nothing in the integrated runtime calls the research service's enqueueCase, so no case is ever built and the
// CATALYST_TRANSMISSION setup is permanently NEEDS_DATA (LEAN-PLAN.md "the differentiator"). This is the flag-source-
// agnostic PLUMBING for that call: given a source of flagged coins and the research service, it enqueues a case for each
// flagged coin that is a DECLARED research subject, debounced by a per-coin cooldown so a persistent flag cannot spend
// the model budget on repeats. It has ZERO authority: it only asks the read-only research service to build a case; the
// Judge later consumes a sealed, verified case through its own case-source (never this module). It calls no model and
// reaches no provider — the service owns the model gate (budget $0 / no credential => the built case is dormant, never
// LIVE_MODEL, so the Judge refuses it) — so this trigger is safe to run before David funds the model. Fail-closed: a
// throwing source or enqueue is counted, never propagated. The concrete flag SOURCE is injected (a product choice);
// this module is what every source shares.
export const CASE_TRIGGER_VERSION = 'case-trigger-1';
export const CASE_TRIGGER_DEFAULT_COOLDOWN_MS = 3_600_000; // one case per coin per hour at most, whatever the flag cadence

// Merge several flag sources into one for the trigger. Each source is read fail-closed: a throwing or non-array source
// contributes nothing and never sinks its siblings. The trigger's own dedup + cooldown handle a coin flagged by more
// than one source. Used to run the fresh-dossier source and the Judge-candidate source side by side.
export function combineFlagSources(...sources) {
  const list = sources.filter((s) => typeof s === 'function');
  return ({ asOfTs } = {}) => {
    const flags = [];
    for (const s of list) { let out; try { out = s({ asOfTs }); } catch { out = null; } if (Array.isArray(out)) flags.push(...out); }
    return flags;
  };
}

// subjects: the declared research subject set (only these can get a case) as { subjects: [{canonicalCoin}] }, an array of
// {canonicalCoin} / strings, or a Set. flaggedCoinsSource({ asOfTs }) returns the currently flagged coins — each a
// canonicalCoin string or { canonicalCoin, reason?, trigger?, entrances?, sourceEventId?, observedTs? }. service is the
// research service (its enqueueCase is the only method used). Nothing is enqueued for a coin that is not a declared
// subject, is on cooldown, or when the service refuses (ceiling / not active) — each outcome is counted.
export function createCaseTrigger({ service, subjects, flaggedCoinsSource, clock = () => Date.now(), cooldownMs = CASE_TRIGGER_DEFAULT_COOLDOWN_MS, log = () => {} } = {}) {
  if (!service || typeof service.enqueueCase !== 'function') throw new Error('case-trigger: a research service with enqueueCase is required');
  const list = Array.isArray(subjects) ? subjects : (subjects?.subjects ?? (subjects instanceof Set ? [...subjects] : []));
  const declared = new Set(list.map((s) => (typeof s === 'string' ? s : s?.canonicalCoin)).filter((c) => typeof c === 'string' && c.length));
  const lastEnqueuedTs = new Map(); // canonicalCoin -> the clock of the last ACCEPTED fresh enqueue (the cooldown anchor)
  const counters = { ticks: 0, flagged: 0, enqueued: 0, duplicate: 0, cooled: 0, notSubject: 0, refused: 0, faults: 0 };
  let stopped = false;

  // one pass over the current flags. Returns a snapshot of the counters. Never throws.
  function tick(now = clock()) {
    if (stopped) return { ...counters };
    counters.ticks += 1;
    let flags;
    try { flags = flaggedCoinsSource?.({ asOfTs: now }) ?? []; }
    catch (err) { counters.faults += 1; log(`case-trigger source failed: ${String(err?.message ?? err).slice(0, 120)}`); return { ...counters }; }
    if (!Array.isArray(flags)) { counters.faults += 1; return { ...counters }; }
    for (const f of flags) {
      const coin = typeof f === 'string' ? f : f?.canonicalCoin;
      if (typeof coin !== 'string' || !coin.length) continue;
      counters.flagged += 1;
      if (!declared.has(coin)) { counters.notSubject += 1; continue; } // only declared research subjects can get a case
      const last = lastEnqueuedTs.get(coin);
      if (last !== undefined && now - last < cooldownMs) { counters.cooled += 1; continue; } // debounce a persistent flag
      let r;
      try { r = service.enqueueCase({ canonicalCoin: coin, trigger: (typeof f === 'object' ? f.trigger : null) ?? null, reason: (typeof f === 'object' ? f.reason : null) ?? 'FLAGGED', entrances: (typeof f === 'object' ? f.entrances : null) ?? null, sourceEventId: (typeof f === 'object' ? f.sourceEventId : null) ?? null, observedTs: (typeof f === 'object' ? f.observedTs : null) ?? now }); }
      catch (err) { counters.faults += 1; log(`case-trigger enqueue threw for ${coin}: ${String(err?.message ?? err).slice(0, 120)}`); continue; }
      if (r?.accepted) {
        if (r.duplicate) counters.duplicate += 1; // already pending: no new spend, no cooldown reset
        else { counters.enqueued += 1; lastEnqueuedTs.set(coin, now); } // a fresh case: start the cooldown
      } else {
        counters.refused += 1; // SERVICE_NOT_ACTIVE / SUBJECT_NOT_DECLARED / PENDING_CEILING: retry next tick, no cooldown
      }
    }
    return { ...counters };
  }

  return {
    tick,
    status: () => ({ version: CASE_TRIGGER_VERSION, cooldownMs, subjects: declared.size, stopped, counters: { ...counters } }),
    stop: () => { stopped = true; },
  };
}
