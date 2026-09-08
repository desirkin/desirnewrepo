// D15 — TOKENOMIST API v5 (alternative paid client, x-api-key): token list, upcoming unlock events (BULK — one call
// covers many tokens), per-token unlock events, allocations and daily emission. The Pro allowance is 300 successful
// requests per month: this client never polls every asset; it prefers the bulk upcoming route, reads the credit
// metadata returned with every authenticated response, and the owner caches unchanged future schedules by source hash.
import { createClientBase, num, int, str, bool, tsFromIso, tsFromMs, arr, obj, assetSubject } from './base.js';
import { quality, deepFreeze } from '../contracts.js';

export const TOKENOMIST_MAPPING_ID = 'tokenomist-v5-slug-v1';
const SLUG_RE = /^[a-z0-9-]{1,80}$/;
const dayPrecision = (ts) => (ts !== null && ts % 86_400_000 === 0 ? 'DAY' : 'MILLISECOND');
export function createTokenomistClient({ transport, clock, log, credential = null } = {}) {
  const base = createClientBase({ providerId: 'TOKENOMIST', transport, clock, log, credential });
  let credit = null; const tokens = new Map();
  const envelope = (r) => { const j = obj(r.json); if (!j) return null; const c = obj(obj(j.metadata)?.credit); if (c) credit = deepFreeze({ used: int(c.used), limit: int(c.limit), resetAt: str(c.resetAt, 40), observedTs: r.receivedTs }); if (j.status === false) return { failure: { kind: 'SCHEMA', reason: `provider status false ${int(j.statusCode) ?? ''}`.trim(), coverageState: int(j.statusCode) === 429 ? 'FAILED' : 'ACCESS_BLOCKED', reasonCode: int(j.statusCode) === 429 ? 'RATE_LIMITED' : 'ENTITLEMENT_DENIED', ts: r.receivedTs } }; return { data: j.data }; };
  async function tokenList({ slugs = null, signal }) {
    const r = await base.call({ endpointId: 'token-list', query: slugs ? { tokenId: slugs.join(',') } : {}, signal, maxBytes: 8 * 1024 * 1024 });
    if (!r.ok) return r; const e = envelope(r); if (!e || e.failure) return { ok: false, failure: e?.failure ?? { kind: 'SCHEMA', reason: 'envelope missing', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs } };
    for (const raw of arr(e.data) ?? []) { const t = obj(raw); const id = str(t?.tokenId ?? t?.id ?? t?.slug, 80); const sym = str(t?.symbol, 20); if (id && SLUG_RE.test(id)) tokens.set(id, { id, symbol: sym ? sym.toUpperCase() : null, name: str(t.name, 120) }); }
    return { ok: true, count: tokens.size, credit, meta: { requestId: r.requestId, receivedTs: r.receivedTs } };
  }
  const resolve = ({ canonicalCoin, slug }) => { if (!SLUG_RE.test(slug ?? '')) return { ok: false, reason: 'COIN_MALFORMED' }; const t = tokens.get(slug); if (!t) return { ok: false, reason: tokens.size ? 'NOT_IN_CATALOG' : 'CATALOG_NOT_LOADED' }; if (t.symbol && t.symbol !== canonicalCoin) return { ok: false, reason: 'AMBIGUOUS_MAPPING' }; return { ok: true, subject: assetSubject({ canonicalCoin, providerAssetId: slug }), token: t }; };
  const emitEvent = ({ endpointId, subject, r, ev, slug, idx }) => {
    const ts = tsFromMs(ev.timestamp) ?? tsFromIso(ev.date ?? ev.unlockDate); const amount = num(ev.cliffAmount ?? ev.unlockAmount); const usd = num(ev.cliffValue ?? ev.unlockValue); const allocs = (arr(ev.allocations) ?? []).map(obj).filter(Boolean);
    const category = allocs.length === 1 ? str(allocs[0].standardAllocation ?? allocs[0].allocationName, 80) : allocs.length > 1 ? 'multiple' : null;
    return base.tryEmit({ endpointId, subject, kind: 'UNLOCK_EVENT', sourceKey: `${slug}:${endpointId}:${ts ?? idx}`, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality(ts !== null && amount !== null ? 'KNOWN' : 'PARTIAL', { reasonCodes: ts !== null && amount !== null ? [] : ['FIELD_MISSING_AT_SOURCE'], methodologyId: `tokenomist-${endpointId}-v5`, originalUnit: 'token' }), provenance: base.provenance(r, { nativeLocator: `${slug}/${ts ?? idx}`, mappingId: TOKENOMIST_MAPPING_ID, vintage: String(r.receivedTs) }), payload: { eventId: `${slug}:${ts ?? idx}`, scheduledTs: ts, timePrecision: ts === null ? 'UNKNOWN' : dayPrecision(ts), amountToken: amount, amountUsd: usd, recipientCategory: category, unlockType: 'CLIFF', tracked: true, allocationName: allocs.length === 1 ? str(allocs[0].allocationName, 120) : null, totalLocked: null, totalUnlocked: null, totalUntracked: null, circulatingSupply: null, scheduleVersion: `tokenomist-v5:${r.receivedTs}` } });
  };
  async function unlockEvents({ canonicalCoin, slug, start = null, end = null, page = 1, pageSize = 50, signal }) {
    const res = resolve({ canonicalCoin, slug }); if (!res.ok) return { ok: false, failure: { kind: 'SCHEMA', reason: res.reason, coverageState: 'NOT_SUPPORTED', reasonCode: 'NOT_IN_CATALOG', ts: base.clock() }, coverage: [] };
    const r = await base.call({ endpointId: 'unlock-events', pathParams: { tokenId: slug }, query: { ...(start ? { start } : {}), ...(end ? { end } : {}), page, pageSize }, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'unlock-events', subject: res.subject, family: 'SUPPLY_UNLOCKS', kind: 'UNLOCK_EVENT', startTs: base.clock() })] };
    const e = envelope(r); if (!e || e.failure) { const f = e?.failure ?? { kind: 'SCHEMA', reason: 'envelope missing', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs }; return { ok: false, failure: f, coverage: [base.failureCoverage(f, { endpointId: 'unlock-events', subject: res.subject, family: 'SUPPLY_UNLOCKS', kind: 'UNLOCK_EVENT', startTs: r.receivedTs })] }; }
    const d = obj(e.data) ?? {}; const rows = (arr(d.events ?? d.data ?? e.data) ?? []).map(obj).filter(Boolean); const out = [];
    rows.forEach((ev, idx) => { const ob = emitEvent({ endpointId: 'unlock-events', subject: res.subject, r, ev, slug, idx }); if (ob) out.push(ob); });
    return { ok: true, observations: out, coverage: [base.coverage({ endpointId: 'unlock-events', subject: res.subject, family: 'SUPPLY_UNLOCKS', kind: 'UNLOCK_EVENT', state: out.length ? 'OBSERVED' : 'GAP', reasonCodes: int(d.totalPages) !== null && int(d.totalPages) > page ? ['PAGINATION_INCOMPLETE'] : [], startTs: r.receivedTs, endTs: r.receivedTs, observationCount: out.length })], credit, meta: { requestId: r.requestId, receivedTs: r.receivedTs, page, totalPages: int(d.totalPages) } };
  }
  async function upcoming({ subjects, start = null, end = null, page = 1, pageSize = 100, signal }) {
    const r = await base.call({ endpointId: 'upcoming-unlock-events', query: { ...(start ? { start } : {}), ...(end ? { end } : {}), page, pageSize }, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [] };
    const e = envelope(r); if (!e || e.failure) return { ok: false, failure: e?.failure ?? { kind: 'SCHEMA', reason: 'envelope missing', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs }, coverage: [] };
    const d = obj(e.data) ?? {}; const rows = (arr(d.events ?? d.data ?? e.data) ?? []).map(obj).filter(Boolean); const out = []; const bySlug = new Map(subjects.map((s) => [s.slug, s]));
    rows.forEach((ev, idx) => { const slug = str(ev.tokenId ?? ev.slug ?? obj(ev.token)?.tokenId, 80); const s = slug ? bySlug.get(slug) : null; if (!s) return; const ob = emitEvent({ endpointId: 'upcoming-unlock-events', subject: assetSubject({ canonicalCoin: s.canonicalCoin, providerAssetId: slug }), r, ev, slug, idx }); if (ob) out.push(ob); });
    return { ok: true, observations: out, coverage: [], credit, meta: { requestId: r.requestId, receivedTs: r.receivedTs, rows: rows.length, matched: out.length } };
  }
  async function allocations({ canonicalCoin, slug, signal }) {
    const res = resolve({ canonicalCoin, slug }); if (!res.ok) return { ok: false, failure: { kind: 'SCHEMA', reason: res.reason, coverageState: 'NOT_SUPPORTED', reasonCode: 'NOT_IN_CATALOG', ts: base.clock() }, coverage: [] };
    const r = await base.call({ endpointId: 'allocations', pathParams: { tokenId: slug }, query: {}, signal });
    if (!r.ok) return { ok: false, failure: r.failure, coverage: [base.failureCoverage(r.failure, { endpointId: 'allocations', subject: res.subject, family: 'SUPPLY_UNLOCKS', kind: 'UNLOCK_EVENT', startTs: base.clock() })] };
    const e = envelope(r); if (!e || e.failure) return { ok: false, failure: e?.failure ?? { kind: 'SCHEMA', reason: 'envelope missing', coverageState: 'FAILED', reasonCode: 'PROVIDER_ERROR', ts: r.receivedTs }, coverage: [] };
    const d = obj(e.data) ?? {}; const out = []; const allocs = (arr(d.allocations) ?? []).map(obj).filter(Boolean).slice(0, 64);
    allocs.forEach((a, i) => { const locked = num(a.lockedAmount ?? a.locked); const unlocked = num(a.unlockedAmount ?? a.unlocked); const tbd = bool(a.isTBD) === true || str(a.standardAllocation, 40) === 'tbd';
      const ob = base.tryEmit({ endpointId: 'allocations', subject: res.subject, kind: 'UNLOCK_EVENT', sourceKey: `${slug}:allocation:${i}`, receivedTs: r.receivedTs, knownAtTs: r.receivedTs, quality: quality('PARTIAL', { reasonCodes: ['FIELD_MISSING_AT_SOURCE'], methodologyId: 'tokenomist-allocations-v5', originalUnit: 'token' }), provenance: base.provenance(r, { nativeLocator: `${slug}/allocation/${i}`, mappingId: TOKENOMIST_MAPPING_ID, vintage: str(d.lastUpdatedDate, 40) }), payload: { eventId: `${slug}:allocation:${i}`, scheduledTs: null, timePrecision: 'UNKNOWN', amountToken: null, amountUsd: null, recipientCategory: str(a.standardAllocation, 80), unlockType: 'UNKNOWN', tracked: !tbd, allocationName: str(a.name ?? a.allocationName, 120), totalLocked: locked, totalUnlocked: unlocked, totalUntracked: null, circulatingSupply: null, scheduleVersion: `tokenomist-v5:${r.receivedTs}` } });
      if (ob) out.push(ob); });
    return { ok: true, observations: out, coverage: [], credit, meta: { requestId: r.requestId, receivedTs: r.receivedTs, maxSupply: num(d.maxSupply) } };
  }
  return { ...base, tokenList, resolve, unlockEvents, upcoming, allocations, credit: () => credit };
}
