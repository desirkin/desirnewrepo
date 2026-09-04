// ATTENTION-1A — the ONE definition of which durable Memory meanings may
// provide Tier-4 display-attention continuity. PURE and READ-SIDE: shared by
// the local read projection, the durable repository query, the MemoryView
// facade, and the UI attention builder so no consumer can quietly broaden
// "Serpent recently noticed this" into "any record mentioning a coin".
//
// Qualifying meanings (canonical fields as the adapters write them):
//   WIDEEYE_RIPPLE       — a Wide Eye ripple envelope
//   RUMINT_NOMINATION    — a RUMOR_OBSERVATION whose payload.type truthfully
//                          says RUMINT_NOMINATION (ordinary polls do NOT count)
// Everything else — TAPE snapshots, MICROSTRUCTURE observations, WIDEEYE
// status/missed/errors, ordinary RUMINT polls, heartbeats — is NOT attention
// continuity and never becomes UI prey through this path.

// event_type values a bounded durable query may narrow on (SQL side); the
// exact meaning check below remains the final truth gate for both stores.
export const ATTENTION_CONTINUITY_EVENT_TYPES = Object.freeze(['WIDEEYE_RIPPLE', 'RUMOR_OBSERVATION']);

// returns 'WIDEEYE_RIPPLE' | 'RUMINT_NOMINATION' | null — never invents.
// Only KNOWN evidence with a real symbol can carry remembered attention.
export function attentionContinuityMeaning(env) {
  if (!env || env.observationState !== 'KNOWN' || !env.symbol) return null;
  if (env.eventType === 'WIDEEYE_RIPPLE') return 'WIDEEYE_RIPPLE';
  if (env.eventType === 'RUMOR_OBSERVATION' && env.payload?.type === 'RUMINT_NOMINATION') return 'RUMINT_NOMINATION';
  return null;
}
