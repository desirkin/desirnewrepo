// PROVENANCE CLOCKS (B-0B.2). A timestamp is part of the evidence:
// a derived field may not claim a retrieval timestamp earlier than any
// source input required to construct that field. And evidence that was
// never retrieved gets NO retrieval timestamp — the NOT_RETRIEVED sentinel,
// never a fabricated clock reading.
export const NOT_RETRIEVED = 'NOT_RETRIEVED';

const parseTs = (x) => {
  const v = typeof x === 'string' || typeof x === 'number' ? x : x?.retrievedTs;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

// Latest valid retrieval timestamp among inputs (ISO strings, epoch-ms
// numbers, or provenance records). null when none is valid.
export function latestRetrievedTs(inputs) {
  const times = inputs.map(parseTs).filter((t) => t !== null);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

// Derived-field provenance from its actual source inputs (B-0B.2 §6):
// - retrievedTs = the LATEST valid retrieval time among the inputs actually
//   used (never the earliest, never the target's alone) — a conclusion is
//   knowable-to-the-builder only once its last input arrived;
// - availableTs = as given (the latest moment the underlying facts became
//   publicly observable — a separate concept, preserved separately);
// - source names the composite identity; sourceInputs (when given) keeps
//   the individual input identities from being flattened away.
export function deriveProvenance({ source, sourceTs = 'UNKNOWN', availableTs = 'UNKNOWN', inputs = [], sourceInputs, kind = 'historical' }) {
  const p = {
    source,
    sourceTs,
    availableTs,
    retrievedTs: latestRetrievedTs(inputs) ?? NOT_RETRIEVED,
    kind,
    form: 'derived',
  };
  if (sourceInputs) p.sourceInputs = sourceInputs;
  return p;
}
