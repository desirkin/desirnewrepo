// Pure displayed-depth arithmetic shared by descriptors and shadow research.
// No provider, filesystem, runtime, or order dependency; callers validate and
// causally align their books. FULL is hypothetical displayed depth, not a fill.
const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };
const round = (v, d = 8) => { if (typeof v !== 'number' || !Number.isFinite(v)) return null; const r = Number(v.toFixed(d)); return Object.is(r, -0) ? 0 : r; };

export function walkBook(levels, { quoteNotional = null, baseQty = null }) {
  const requested = quoteNotional !== null ? { quoteNotional } : { baseQty };
  if (!Array.isArray(levels) || !levels.length || (quoteNotional === null && baseQty === null)) return deepFreeze({ recipeId: 'book_walk', version: 1, requested, consumedLevels: 0, filledBase: 0, filledQuote: 0, residualQuote: quoteNotional, residualBase: baseQty, averagePrice: null, worstPrice: null, coverage: 'NO_BOOK', hypothetical: true });
  let remQ = quoteNotional; let remB = baseQty; let fb = 0; let fq = 0; let consumed = 0; let worst = null;
  for (const [p, q] of levels) { if (q <= 0) continue; let take; if (quoteNotional !== null) { take = Math.min(q, remQ / p); } else take = Math.min(q, remB); if (take <= 0) break; fb += take; fq += take * p; consumed += 1; worst = p; if (quoteNotional !== null) remQ -= take * p; else remB -= take; if ((quoteNotional !== null && remQ <= 1e-9) || (baseQty !== null && remB <= 1e-12)) { remQ = quoteNotional !== null ? 0 : null; remB = baseQty !== null ? 0 : null; break; } }
  const full = quoteNotional !== null ? remQ <= 1e-9 : remB <= 1e-12;
  return deepFreeze({ recipeId: 'book_walk', version: 1, requested, consumedLevels: consumed, filledBase: round(fb), filledQuote: round(fq), residualQuote: quoteNotional !== null ? round(Math.max(0, remQ)) : null, residualBase: baseQty !== null ? round(Math.max(0, remB)) : null, averagePrice: fb > 0 ? round(fq / fb) : null, worstPrice: worst, coverage: full ? 'FULL' : 'PARTIAL', hypothetical: true, preFee: true });
}
