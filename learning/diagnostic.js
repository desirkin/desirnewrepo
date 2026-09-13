// LEARN-1 / ADDENDUM-2 §06/§07 — the bounded, repeatable named-versus-masked diagnostic harness.
//
// Registration BEFORE execution: sample IDs (selected independently of eventual success, before reading diagnostic
// outcomes), transformations, model/version, prompt digest, conditions, repeats, comparison metric, request/cost
// budget and endpoint are all sealed in the manifest first. The harness runs over INJECTED immutable packets and an
// INJECTED bounded model transport (a fixture transport in tests; a live transport must ride the existing shared
// budget and is NOT wired in this environment — status says WAITING_FOR_BUDGET honestly). Each condition runs in an
// isolated fresh context: the cache key includes model, prompt digest, packet digest, condition AND transformation
// version, so named and masked calls can never share a response. Repeats estimate sampling variation and are
// counted as REPEATS, never independent market observations; retries do not inflate samples.
//
// Interpretation law, stated in the output: a material named/masked difference is a DIAGNOSTIC FINDING, not proof
// of memorization (identity removal also removes information); NO difference is NOT proof of cleanliness; period
// performance decay alone is never a confirmed-memorization verdict. This harness imports no judge module, no
// provider client, performs no promotion, and never runs in Judge admission, The Watch, execution dispatch or the
// HTTP request path.
import { canonicalDigest, isTs, isCount, deepFreeze, utcDateOf } from './contracts.js';
import { buildPseudonyms, maskPacket, MASKING_VERSION } from './masking.js';

export const DIAGNOSTIC_VERSION = 'learning-model-diagnostic-1';
export const CONDITIONS = Object.freeze(['NAMED', 'IDENTITY_MASKED']);
export const DIAGNOSTIC_STATES = Object.freeze(['REGISTERED', 'RUNNING', 'COMPLETED', 'WAITING_FOR_BUDGET', 'FAILED']);
export const INTERPRETATION_LAWS = Object.freeze([
  'A_DIFFERENCE_IS_A_FINDING_NOT_PROOF_OF_MEMORIZATION',
  'NO_DIFFERENCE_IS_NOT_PROOF_OF_CLEANLINESS',
  'PERIOD_DECAY_ALONE_IS_NOT_CONFIRMED_MEMORIZATION',
  'REPEATS_ARE_REPEATS_NEVER_INDEPENDENT_EPISODES',
]);

// seal the manifest BEFORE any call. packets: [{ sampleId, groupId, packet, identifiers }] — outcome-independent,
// chosen before reading diagnostic outputs (the caller's registration law; the sampleIds are frozen here).
export function registerDiagnostic({ store, packets, model, promptDigest, repeats = 2, maxCalls, createdTs, seed = 'diag-1' }) {
  if (!Array.isArray(packets) || packets.length === 0) throw new Error('registerDiagnostic: packets required');
  if (!isCount(repeats) || repeats < 1 || repeats > 8) throw new Error('registerDiagnostic: repeats malformed');
  if (!isCount(maxCalls) || maxCalls < 1) throw new Error('registerDiagnostic: a finite call budget is required');
  if (!isTs(createdTs)) throw new Error('registerDiagnostic: creation clock malformed');
  const identifiers = [...new Set(packets.flatMap((p) => p.identifiers))];
  const pseudonyms = buildPseudonyms(identifiers);
  const samples = packets.map((p) => ({ sampleId: p.sampleId, groupId: p.groupId, packetDigest: canonicalDigest(p.packet) }));
  const manifest = {
    diagnosticVersion: DIAGNOSTIC_VERSION, diagnosticId: `ldiag-${canonicalDigest({ samples, model, promptDigest, seed, createdTs }).slice(0, 40)}`,
    createdTs, model, promptDigest, conditions: [...CONDITIONS], repeats, maxCalls, seed,
    maskingVersion: MASKING_VERSION, samples, groupCount: new Set(packets.map((p) => p.groupId)).size,
    counterbalanceLaw: 'CONDITION_ORDER_ALTERNATES_BY_SAMPLE_INDEX',
    interpretationLaws: [...INTERPRETATION_LAWS], state: 'REGISTERED',
    // the PRIVATE mapping is sealed beside the manifest for audit and NEVER enters a model input
    privatePseudonyms: Object.fromEntries(pseudonyms),
  };
  store.writeDiagnosticManifest(manifest);
  return deepFreeze({ manifest, pseudonyms });
}

// run the registered diagnostic over an injected transport: transport({ model, condition, cacheKey, packet }) ->
// { output, usage } (throws on failure). budgetRemaining() -> integer calls left in the SHARED budget.
export async function runDiagnostic({ store, diagnosticId, packets, transport, budgetRemaining = () => Infinity, nowTs }) {
  const manifest = store.readDiagnosticManifest(diagnosticId);
  if (!manifest) throw new Error('runDiagnostic: unregistered diagnostic (registration precedes execution)');
  const pseudonyms = new Map(Object.entries(manifest.privatePseudonyms));
  const byId = new Map(packets.map((p) => [p.sampleId, p]));
  const existing = new Set(store.readDiagnosticResults(diagnosticId).map((r) => `${r.sampleId}|${r.condition}|${r.repeat}`));
  let calls = 0; let waited = false;
  for (let i = 0; i < manifest.samples.length; i += 1) {
    const s = manifest.samples[i];
    const p = byId.get(s.sampleId);
    if (!p || canonicalDigest(p.packet) !== s.packetDigest) throw new Error(`runDiagnostic: packet ${s.sampleId} missing or changed since registration`);
    const order = i % 2 === 0 ? manifest.conditions : [...manifest.conditions].reverse(); // counterbalanced execution order
    for (const condition of order) {
      const m = condition === 'IDENTITY_MASKED' ? maskPacket(p.packet, { pseudonyms }) : null;
      const input = condition === 'IDENTITY_MASKED' ? m.masked : p.packet;
      for (let repeat = 0; repeat < manifest.repeats; repeat += 1) {
        const key = `${s.sampleId}|${condition}|${repeat}`;
        if (existing.has(key)) continue; // resume without double-charging; a retry is the same repeat slot, never a new sample
        if (calls >= manifest.maxCalls || budgetRemaining() <= 0) {
          store.writeDiagnosticState(diagnosticId, { state: 'WAITING_FOR_BUDGET', updatedTs: nowTs, callsThisRun: calls });
          waited = true; break;
        }
        // isolated fresh context per call: the cache identity carries model + prompt + packet + condition + masking version
        const cacheKey = canonicalDigest({ model: manifest.model, promptDigest: manifest.promptDigest, packetDigest: s.packetDigest, condition, maskingVersion: manifest.maskingVersion, repeat, seed: manifest.seed });
        let row;
        try {
          const r = await transport({ model: manifest.model, condition, cacheKey, packet: input });
          calls += 1;
          row = { diagnosticId, sampleId: s.sampleId, groupId: s.groupId, condition, repeat, cacheKey, ok: true, outputDigest: canonicalDigest(r.output ?? null), output: r.output ?? null, usage: r.usage ?? null, residualClues: condition === 'IDENTITY_MASKED' ? m.residualClues : [], recordedTs: nowTs };
        } catch (err) {
          calls += 1;
          row = { diagnosticId, sampleId: s.sampleId, groupId: s.groupId, condition, repeat, cacheKey, ok: false, outputDigest: null, output: null, usage: null, error: String(err.message).slice(0, 200), residualClues: [], recordedTs: nowTs };
        }
        store.appendDiagnosticResult(diagnosticId, row);
        existing.add(key);
      }
      if (waited) break;
    }
    if (waited) break;
  }
  if (!waited) store.writeDiagnosticState(diagnosticId, { state: 'COMPLETED', updatedTs: nowTs, callsThisRun: calls });
  return summarizeDiagnostic({ store, diagnosticId });
}

// paired summary at GROUP level (dependence groups, never repeated calls): action/score deltas where the injected
// scorer applies; abstentions and failures stay visible.
export function summarizeDiagnostic({ store, diagnosticId, scoreOf = (out) => (out && typeof out.score === 'number' ? out.score : null) }) {
  const manifest = store.readDiagnosticManifest(diagnosticId);
  const rows = store.readDiagnosticResults(diagnosticId);
  const state = store.readDiagnosticState(diagnosticId);
  const byGroup = new Map();
  for (const r of rows) {
    if (!byGroup.has(r.groupId)) byGroup.set(r.groupId, { NAMED: [], IDENTITY_MASKED: [], failures: 0 });
    const g = byGroup.get(r.groupId);
    if (!r.ok) { g.failures += 1; continue; }
    const sc = scoreOf(r.output);
    if (sc !== null) g[r.condition].push(sc);
  }
  const deltas = [];
  let abstentions = 0;
  for (const g of byGroup.values()) {
    if (g.NAMED.length === 0 || g.IDENTITY_MASKED.length === 0) { abstentions += 1; continue; }
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length; // repeats collapse to one group observation
    deltas.push(mean(g.NAMED) - mean(g.IDENTITY_MASKED));
  }
  const meanDelta = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
  const residual = rows.flatMap((r) => r.residualClues ?? []);
  return deepFreeze({
    diagnosticId, state: state?.state ?? manifest.state, utcDate: utcDateOf(state?.updatedTs ?? manifest.createdTs),
    groups: byGroup.size, pairedGroups: deltas.length, abstentionsOrIncomplete: abstentions,
    failures: rows.filter((r) => !r.ok).length, calls: rows.length, repeatsPerCondition: manifest.repeats,
    namedVsMaskedMeanDelta: meanDelta, residualIdentityClues: residual.length,
    interpretationLaws: manifest.interpretationLaws,
    wording: 'historical LLM result; contamination not excluded — a delta is a finding, its absence is not purity',
  });
}
