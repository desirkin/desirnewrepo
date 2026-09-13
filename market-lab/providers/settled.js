// D14 — EXISTING OFFICIAL / SOCIAL / INFRASTRUCTURE / GOVERNANCE OBSERVATIONS: read-only projections from their actual
// settled records into the new evidence path. This module opens NO network and NO Social connection; it consumes the
// accessors the composition root injects (atomic status files of the gateway / governance collectors, the RUMOR
// collector's narrow research accessor). Retention, identity, source status, time, independence and known-gap laws
// of the originals are preserved: a settled record that lacks a clock is not given one.
import { createClientBase, num, int, str, bool, tsFromIso, tsFromMs, arr, obj, assetSubject, providerSubject } from './base.js';
import { quality } from '../contracts.js';

export const SETTLED_MAPPING_ID = 'settled-records-projection-v1';
const DOOR_STATUS = { OPEN: 'OPERATIONAL', DEGRADED: 'DEGRADED', MAINTENANCE: 'DEGRADED', CLOSED: 'OUTAGE', UNKNOWN: 'UNKNOWN' };
export function createSettledProjection({ clock, log, accessors = {} } = {}) {
  const base = createClientBase({ providerId: 'SETTLED_RECORDS', transport: { request: async () => ({ ok: false, failure: { kind: 'ENDPOINT_UNKNOWN', reason: 'settled records perform no network requests' } }) }, clock, log });
  const safe = (name, ...args) => { const fn = accessors[name]; if (typeof fn !== 'function') return { present: false, value: null }; try { return { present: true, value: fn(...args) ?? null }; } catch (err) { log(`settled accessor ${name} failed (contained): ${String(err?.message ?? err).slice(0, 120)}`); return { present: true, value: null, failed: true }; } };
  const prov = (locator, vintage = null) => ({ requestId: null, bytesSha256: null, nativeLocator: locator, mappingId: SETTLED_MAPPING_ID, specificationId: null, vintage });
  // gateway door matrix -> PROVIDER_STATUS per venue door; incidents -> EVENT_REFERENCE (INFRA_INCIDENT)
  function infrastructure({ canonicalCoin, receivedTs }) {
    const out = []; const coverage = [];
    const m = safe('gatewayMatrix'); const doors = obj(obj(m.value)?.doors); const matrixTs = tsFromIso(obj(m.value)?.ts);
    if (!m.present || !doors) { coverage.push(base.coverage({ endpointId: 'gateway-status', subject: providerSubject('kraken-status'), family: 'INFRASTRUCTURE_STATUS', kind: 'PROVIDER_STATUS', state: m.present ? 'GAP' : 'NOT_QUERIED', reasonCodes: [], startTs: receivedTs, endTs: receivedTs })); return { observations: out, coverage }; }
    const d = obj(doors[canonicalCoin]);
    for (const door of ['funding', 'trading']) { const st = d ? DOOR_STATUS[str(d[door], 16) ?? 'UNKNOWN'] ?? 'UNKNOWN' : 'UNKNOWN';
      const ob = base.tryEmit({ endpointId: 'gateway-status', subject: providerSubject('kraken-status'), kind: 'PROVIDER_STATUS', sourceKey: `${canonicalCoin}:${door}`, sourceEventTs: matrixTs, receivedTs, knownAtTs: receivedTs, quality: quality(d ? 'KNOWN' : 'MISSING', { reasonCodes: d ? [] : ['FIELD_MISSING_AT_SOURCE'], methodologyId: 'gateway-door-matrix-v1' }), provenance: prov(`gateway/matrix/${canonicalCoin}/${door}`), payload: { providerId: 'kraken-status', status: st, component: `${canonicalCoin}:${door}`, incidentRef: null } });
      if (ob) out.push(ob); }
    const inc = safe('gatewayIncidents'); const state = obj(inc.value) ?? {};
    for (const [key, raw] of Object.entries(state).slice(0, 64)) { const e = obj(raw); const assets = arr(e?.assets) ?? []; if (!assets.includes(canonicalCoin)) continue; const ts = tsFromIso(e.announcedAt);
      const ob = base.tryEmit({ endpointId: 'gateway-status', subject: assetSubject({ canonicalCoin }), kind: 'EVENT_REFERENCE', sourceKey: key.slice(0, 120), sourceEventTs: ts, publishedTs: ts !== null && ts <= receivedTs ? ts : null, receivedTs, knownAtTs: receivedTs, quality: quality('KNOWN', { methodologyId: 'gateway-incident-state-v1' }), provenance: prov(`gateway/incidents/${key.slice(0, 80)}`), payload: { eventKind: 'INFRA_INCIDENT', sourceProvider: key.split(':')[0].replace(/[^A-Za-z0-9_.-]/g, '-') || 'gateway', nativeRef: key.replace(/[^A-Za-z0-9._:@/+-]/g, '-').slice(0, 120), sourceEventTs: ts, headline: str(e.title, 300), untrusted: true, status: str(e.stage, 40) } });
      if (ob) out.push(ob); }
    return { observations: out, coverage: [base.coverage({ endpointId: 'gateway-status', subject: providerSubject('kraken-status'), family: 'INFRASTRUCTURE_STATUS', kind: 'PROVIDER_STATUS', state: 'OBSERVED', startTs: matrixTs ?? receivedTs, endTs: receivedTs, observationCount: out.length })] };
  }
  // governance status (proposal counts) + governance events for a symbol -> EVENT_REFERENCE (GOVERNANCE_PROPOSAL)
  function governance({ canonicalCoin, receivedTs, maxEvents = 32 }) {
    const out = []; const s = safe('governanceStatus'); const st = obj(s.value);
    if (!s.present) return { observations: out, coverage: [base.coverage({ endpointId: 'governance-status', subject: providerSubject('governance'), family: 'OFFICIAL_SOCIAL_EVENTS', kind: 'EVENT_REFERENCE', state: 'NOT_QUERIED', startTs: receivedTs, endTs: receivedTs })] };
    const health = base.tryEmit({ endpointId: 'governance-status', subject: providerSubject('governance'), kind: 'PROVIDER_STATUS', sourceKey: 'governance', sourceEventTs: tsFromMs(st?.tsMs), receivedTs, knownAtTs: receivedTs, quality: quality(st ? 'KNOWN' : 'MISSING', { reasonCodes: st ? [] : ['FIELD_MISSING_AT_SOURCE'], methodologyId: 'governance-status-v1' }), provenance: prov('governance/status'), payload: { providerId: 'governance', status: !st ? 'UNKNOWN' : st.status === 'HEALTHY' ? 'OPERATIONAL' : st.status === 'DEGRADED' ? 'DEGRADED' : 'OUTAGE', component: str(st?.initState, 80), incidentRef: null } });
    if (health) out.push(health);
    const ev = safe('governanceEvents', canonicalCoin); const events = (arr(ev.value) ?? []).map(obj).filter((e) => e && e.type === 'GOVERNANCE_OBSERVATION' && e.symbol === canonicalCoin).slice(-maxEvents);
    for (const e of events) { const ts = tsFromIso(e.ts); const pid = str(e.proposalId, 200); const entity = str(e.spaceId ?? e.governorId, 120); if (!pid || !entity || ts === null) continue;
      const ob = base.tryEmit({ endpointId: 'governance-status', subject: assetSubject({ canonicalCoin }), kind: 'EVENT_REFERENCE', sourceKey: str(e.sourceEventId, 120) ?? `${entity}:${pid}`.slice(0, 120), sourceEventTs: ts, publishedTs: ts <= receivedTs ? ts : null, receivedTs, knownAtTs: Math.max(receivedTs, tsFromIso(e.retrievedTs) ?? receivedTs), quality: quality('KNOWN', { methodologyId: 'governance-observation-v1' }), provenance: prov(`governance/${entity.slice(0, 60)}/${pid.slice(0, 60)}`, str(e.stateFingerprint, 80)), payload: { eventKind: 'GOVERNANCE_PROPOSAL', sourceProvider: str(e.provider, 40) ?? 'governance', nativeRef: `${entity}:${pid}`.replace(/[^A-Za-z0-9._:@/+-]/g, '-').slice(0, 120), sourceEventTs: ts, headline: null, untrusted: false, status: `${str(e.proposalState, 20) ?? 'unknown'}${e.lifecycleTransition ? `:${str(e.lifecycleTransition, 30)}` : ''}`.slice(0, 40) } });
      if (ob) out.push(ob); }
    return { observations: out, coverage: [base.coverage({ endpointId: 'governance-status', subject: providerSubject('governance'), family: 'OFFICIAL_SOCIAL_EVENTS', kind: 'EVENT_REFERENCE', state: out.length ? 'OBSERVED' : 'GAP', startTs: receivedTs, endTs: receivedTs, observationCount: out.length })] };
  }
  // RUMOR collector research accessor -> OFFICIAL_CLAIM references + SOCIAL_DOSSIER reference (the detached DTO itself
  // travels to the evidence builder through the Social projection adapter; here only the reference is projected)
  function official({ canonicalCoin, asOfTs, receivedTs }) {
    const out = []; const s = safe('researchProjection', canonicalCoin, { asOfTs });
    if (!s.present) return { observations: out, coverage: [base.coverage({ endpointId: 'official-claims', subject: providerSubject('rumor2'), family: 'OFFICIAL_SOCIAL_EVENTS', kind: 'EVENT_REFERENCE', state: 'NOT_QUERIED', startTs: receivedTs, endTs: receivedTs })] };
    const p = obj(s.value);
    for (const c of (arr(p?.claims) ?? []).map(obj).filter(Boolean).slice(0, 32)) { const id = str(c.claimId, 120); const ts = tsFromMs(c.firstObservedTs); if (!id || ts === null || ts > asOfTs) continue;
      const ob = base.tryEmit({ endpointId: 'official-claims', subject: assetSubject({ canonicalCoin }), kind: 'EVENT_REFERENCE', sourceKey: id, sourceEventTs: ts, receivedTs, knownAtTs: Math.max(receivedTs, tsFromMs(c.knownAtTs) ?? receivedTs), quality: quality('KNOWN', { methodologyId: 'rumor2-claim-reference-v1' }), provenance: prov(`rumor2/claim/${id.slice(0, 80)}`), payload: { eventKind: 'OFFICIAL_CLAIM', sourceProvider: str(c.provider, 40) ?? 'rumor2', nativeRef: id, sourceEventTs: ts, headline: null, untrusted: false, status: str(c.status, 40) } });
      if (ob) out.push(ob); }
    const d = obj(obj(p?.composite)?.dossier);
    if (d && str(d.dossierId, 120) && tsFromMs(d.derivedKnownAtTs) !== null && d.derivedKnownAtTs <= asOfTs) { const ob = base.tryEmit({ endpointId: 'social-dossier', subject: assetSubject({ canonicalCoin }), kind: 'EVENT_REFERENCE', sourceKey: d.dossierId, sourceEventTs: d.derivedKnownAtTs, receivedTs, knownAtTs: Math.max(receivedTs, d.derivedKnownAtTs), quality: quality('KNOWN', { methodologyId: 'social-dossier-reference-v1' }), provenance: prov(`rumor2/dossier/${d.dossierId.slice(0, 80)}`), payload: { eventKind: 'SOCIAL_DOSSIER', sourceProvider: 'rumor2-research', nativeRef: d.dossierId, sourceEventTs: d.derivedKnownAtTs, headline: null, untrusted: false, status: `${str(d.researchState, 24) ?? 'unknown'}`.slice(0, 40) } }); if (ob) out.push(ob); }
    return { observations: out, coverage: [base.coverage({ endpointId: 'official-claims', subject: providerSubject('rumor2'), family: 'OFFICIAL_SOCIAL_EVENTS', kind: 'EVENT_REFERENCE', state: p ? (out.length ? 'OBSERVED' : 'GAP') : 'GAP', startTs: receivedTs, endTs: receivedTs, observationCount: out.length })] };
  }
  function project({ canonicalCoin, asOfTs, receivedTs = clock ? clock() : Date.now() }) {
    const a = infrastructure({ canonicalCoin, receivedTs }); const b = governance({ canonicalCoin, receivedTs }); const c = official({ canonicalCoin, asOfTs: asOfTs ?? receivedTs, receivedTs });
    return { ok: true, observations: [...a.observations, ...b.observations, ...c.observations], coverage: [...a.coverage, ...b.coverage, ...c.coverage], meta: { accessors: Object.keys(accessors).filter((k) => typeof accessors[k] === 'function') } };
  }
  return { ...base, project, infrastructure, governance, official };
}
