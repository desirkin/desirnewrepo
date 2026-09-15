// FRESH-DOSSIER flag source (Ticket 6, 2026-09-15). David's decision: a coin gets a Socrates case when a SENSE surfaces
// a fresh catalyst/dossier for it. The rumor2 social research strainer already derives a settled per-coin dossier and the
// research service already consumes its detached read-only projection (socialSource -> researchProjection); this is the
// concrete flag SOURCE the case trigger listens to. On each poll it reads each declared subject's latest dossier and
// flags the coin when its dossierId (the semantic content hash of the dossier — it changes exactly when the derived
// picture changes) is new since the last poll. First sight of a dossier counts as fresh (an existing dossier IS a signal
// that surfaced); the case trigger's per-coin cooldown then spaces repeats. Read-only: it derives no truth, calls no
// model, reaches no provider — it only turns "a new dossier exists" into a flag; the case trigger + service decide the
// rest. Pure (imports nothing). Other senses (press, discovery, gateway) can add their own flag sources feeding the same
// trigger later.
export const DOSSIER_FLAG_SOURCE_VERSION = 'dossier-flag-source-1';

// socialSource(coin, { asOfTs }) is the research projection accessor (fly.js wires rumor2Handle.researchProjection); it
// returns { dossierRecord: { dossierId, derivedKnownAtTs, entrances } | null } | null. subjects is the declared research
// subject set ({ subjects: [{canonicalCoin}] }, an array, or a Set) — the coins polled (only these can get a case).
export function createDossierFlagSource({ socialSource, subjects, log = () => {} } = {}) {
  const list = Array.isArray(subjects) ? subjects : (subjects?.subjects ?? (subjects instanceof Set ? [...subjects] : []));
  const declared = [...new Set(list.map((s) => (typeof s === 'string' ? s : s?.canonicalCoin)).filter((c) => typeof c === 'string' && c.length))];
  const lastDossierId = new Map(); // canonicalCoin -> the dossierId last flagged (the freshness key)

  // ({ asOfTs }) -> the coins whose dossier is new since the last poll, each a flag the case trigger understands.
  return ({ asOfTs } = {}) => {
    if (typeof socialSource !== 'function' || !declared.length) return [];
    const flags = [];
    for (const coin of declared) {
      let dossier = null;
      try { dossier = socialSource(coin, { asOfTs })?.dossierRecord ?? null; }
      catch (err) { log(`dossier-flag-source read failed for ${coin}: ${String(err?.message ?? err).slice(0, 120)}`); continue; }
      const dossierId = dossier?.dossierId;
      if (typeof dossierId !== 'string' || !dossierId.length) continue; // no dossier yet: nothing to flag
      if (lastDossierId.get(coin) === dossierId) continue; // unchanged since the last poll
      lastDossierId.set(coin, dossierId);
      const observedTs = Number.isSafeInteger(dossier.derivedKnownAtTs) ? dossier.derivedKnownAtTs : (Number.isSafeInteger(asOfTs) ? asOfTs : null);
      flags.push({
        canonicalCoin: coin,
        reason: 'FRESH_DOSSIER',
        sourceEventId: dossierId,
        observedTs,
        entrances: dossier.entrances ?? null,
        trigger: { kind: 'RESEARCH_DOSSIER', sourceEventId: dossierId, observedTs },
      });
    }
    return flags;
  };
}
