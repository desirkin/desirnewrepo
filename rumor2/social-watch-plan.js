// SOCIAL-4F — PAID_WATCH_PLAN + the EXPLICIT X watch scope. Pure. Observation-only.
//
//   PAID_WATCH_PLAN: a bounded subset PROPOSED for expensive research. A plan is
//   not a provider subscription, not permission to spend, not trading attention
//   or eligibility. It is query/resource prioritization — never a trading score,
//   a new setup family, a profitability forecast, or winner-only sampling.
//
//   CRITICAL X SEPARATION: neither the broad catalog nor a generated plan ever
//   replaces an authorized paid rule set. The X runtime compiles rules ONLY from
//   the EXPLICIT operator watch scope (config.socialResearch.xWatch, verified
//   against the accepted catalog) or from a scope injected by a test. A missing /
//   empty selection is WATCH_SCOPE_NOT_CONFIGURED: zero X requests, no five-coin
//   fallback, no full-catalog fallback. A generated plan is shown as PROPOSED.
import { contentHash, canonicalJson } from './truth.js';
import { catalogBases, aliasFactsFor, SOCIAL_X_WATCH_MAX_ASSETS } from './social-catalog.js';

export const WATCH_PLAN_VERSION = 1;
export const WATCH_PLAN_STATUS = 'PROPOSED'; // the only status a generated plan can carry
export const WATCH_PLAN_DEFAULT_CAP = SOCIAL_X_WATCH_MAX_ASSETS;
export const WATCH_PLAN_PRIORITY = Object.freeze(['OPERATOR_CANDIDATE', 'RIPPLE_NOTICE', 'MISSED_NOTICE']); // explicit bounded input priority, in this order
export const WATCH_PLAN_DEFERRAL_REASONS = Object.freeze(['RESOURCE_CAP', 'NO_RESEARCH_SIGNAL_YET']);
export const X_WATCH_SCOPE_MODES = Object.freeze(['NOT_CONFIGURED', 'EXPLICIT_STATIC', 'INJECTED_STATIC']);
export const X_WATCH_SCOPE_REASONS = Object.freeze(['WATCH_SCOPE_NOT_CONFIGURED', 'WATCH_SCOPE_CATALOG_UNAVAILABLE', 'WATCH_SCOPE_CATALOG_STALE', 'WATCH_SCOPE_EMPTY_AFTER_VERIFICATION', 'WATCH_SCOPE_EXCEEDS_CAP', 'WATCH_SCOPE_MALFORMED']);
const MAX_NOTICES = 500; const MAX_OPERATOR_CANDIDATES = 100;
const TICKER_RE = /^[A-Z0-9]{2,15}$/;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const deepFreeze = (o) => { if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o; Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); return o; };
export const xWatchScopeId = ({ mode, tickers, aliases }) => contentHash(canonicalJson({ mode, tickers: [...tickers].sort(), aliases: [...aliases].sort() }));

// Resolve the EXPLICIT X watch scope: operator tickers verified against the accepted catalog
// (or a test-injected static list). Never derived from config.universe, never from a plan.
// SOCIAL-4F CLOSEOUT: catalog FRESHNESS survives this boundary. The collector passes the research
// scope source's whole `candidate` — a catalog carried only diagnostically on a STALE / UNAVAILABLE
// (future-clock, invalid, not-accepted) candidate is NOT permission to verify a NEW paid scope.
export function resolveXWatchScope({ research = null, catalog = null, injected = null, candidate = null } = {}) {
  const fail = (reason, detail, extra = {}) => ({ ok: false, mode: injected ? 'INJECTED_STATIC' : (research?.xWatch?.mode ?? 'NOT_CONFIGURED'), reason, detail, tickers: [], aliases: [], scopeId: null, catalogStatus: candidate ? candidate.status ?? null : (catalog ? 'CATALOG_BACKED' : null), ...extra });
  if (candidate !== null && injected === null) {
    if (!candidate || typeof candidate !== 'object') return fail('WATCH_SCOPE_CATALOG_UNAVAILABLE', 'no research scope candidate');
    const xw0 = research?.xWatch;
    if (!xw0 || xw0.mode === 'NOT_CONFIGURED') return fail('WATCH_SCOPE_NOT_CONFIGURED', 'no explicit X watch selection is configured (socialResearch.xWatch) — zero X requests');
    if (candidate.status === 'STALE') return fail('WATCH_SCOPE_CATALOG_STALE', `${candidate.reason ?? 'the accepted catalog is stale'} — a stale catalog verifies no NEW paid scope`);
    if (candidate.status !== 'CATALOG_BACKED' || !candidate.catalog) return fail('WATCH_SCOPE_CATALOG_UNAVAILABLE', `${candidate.reason ?? candidate.status ?? 'no fresh accepted catalog'} — explicit tickers are verified only against a FRESH accepted catalog`);
    catalog = candidate.catalog;
  }
  if (injected) {
    const tickers = [...new Set((Array.isArray(injected.tickers) ? injected.tickers : []).filter((t) => typeof t === 'string' && TICKER_RE.test(t)))].sort();
    const aliases = [...new Set((Array.isArray(injected.aliases) ? injected.aliases : []).filter((a) => typeof a === 'string'))].sort();
    if (tickers.length === 0) return fail('WATCH_SCOPE_NOT_CONFIGURED', 'the injected static scope names no ticker');
    if (tickers.length > WATCH_PLAN_DEFAULT_CAP) return fail('WATCH_SCOPE_EXCEEDS_CAP', `${tickers.length} tickers exceed the ${WATCH_PLAN_DEFAULT_CAP} asset cap — never truncated silently`);
    return deepFreeze({ ok: true, mode: 'INJECTED_STATIC', reason: null, detail: 'test/smoke-injected static scope (labelled; never a production fallback)', tickers, aliases, verified: [], rejected: [], scopeId: xWatchScopeId({ mode: 'INJECTED_STATIC', tickers, aliases }) });
  }
  const xw = research?.xWatch;
  if (!xw || xw.mode === 'NOT_CONFIGURED') return fail('WATCH_SCOPE_NOT_CONFIGURED', 'no explicit X watch selection is configured (socialResearch.xWatch) — zero X requests');
  if (xw.mode !== 'EXPLICIT_STATIC') return fail('WATCH_SCOPE_MALFORMED', `unknown xWatch mode ${xw.mode}`);
  if (!catalog) return fail('WATCH_SCOPE_CATALOG_UNAVAILABLE', 'explicit tickers must be verified against an accepted catalog before any paid rule is compiled');
  const bases = new Set(catalogBases(catalog));
  const verified = xw.tickers.filter((t) => bases.has(t)).sort();
  const rejected = xw.tickers.filter((t) => !bases.has(t)).map((t) => ({ ticker: t, reason: 'WATCH_TICKER_NOT_IN_CATALOG' }));
  const cap = Math.min(xw.maxAssets, WATCH_PLAN_DEFAULT_CAP);
  if (verified.length === 0) return fail('WATCH_SCOPE_EMPTY_AFTER_VERIFICATION', `none of the ${xw.tickers.length} configured tickers is in the accepted catalog`, { rejected });
  if (verified.length > cap) return fail('WATCH_SCOPE_EXCEEDS_CAP', `${verified.length} verified tickers exceed the cap ${cap}`, { rejected });
  const aliases = aliasFactsFor(verified).map((a) => a.alias);
  return deepFreeze({ ok: true, mode: 'EXPLICIT_STATIC', reason: null, detail: `operator-configured explicit scope verified against catalog ${catalog.contentId.slice(0, 12)}`, tickers: verified, aliases, verified, rejected, scopeId: xWatchScopeId({ mode: 'EXPLICIT_STATIC', tickers: verified, aliases }), catalogContentId: catalog.contentId, catalogObservedTs: catalog.observedTs, catalogStatus: 'CATALOG_BACKED' });
}

// Build the observation-only PROPOSED plan. Inputs are the accepted catalog and ALREADY-KNOWN
// bounded research notices (the wide eye's RIPPLE / MISSED records — both included as context;
// a MISSED label never means untradeable forever) plus optional explicit operator candidates.
// Nothing here pulls future data. Deterministic: explicit priority order, then most recent
// notice first, then |zVol| descending, then base lexical. A deferred asset stays in discovery.
export function buildWatchPlan({ catalog, notices = [], operatorCandidates = [], maxAssets = WATCH_PLAN_DEFAULT_CAP, operatorCap = null, nowMs } = {}) {
  if (!catalog || !Array.isArray(catalog.markets)) return { error: 'watch plan: an accepted catalog is required (no plan from prose, guesses, or the legacy config asset list)' };
  if (!Number.isSafeInteger(nowMs)) return { error: 'watch plan: creation clock must be a safe integer' };
  const capBase = Number.isSafeInteger(maxAssets) && maxAssets > 0 ? Math.min(maxAssets, WATCH_PLAN_DEFAULT_CAP) : WATCH_PLAN_DEFAULT_CAP;
  const cap = Number.isSafeInteger(operatorCap) && operatorCap > 0 ? Math.min(capBase, operatorCap) : capBase;
  const bases = new Set(catalogBases(catalog));
  const ops = [...new Set((Array.isArray(operatorCandidates) ? operatorCandidates : []).filter((t) => typeof t === 'string' && bases.has(t)))].slice(0, MAX_OPERATOR_CANDIDATES);
  const byBase = new Map();
  for (const t of ops) byBase.set(t, { base: t, priority: 0, reasons: ['OPERATOR_CANDIDATE'], lastNoticeTs: null, zVol: null, verdicts: [] });
  const list = (Array.isArray(notices) ? notices : []).slice(0, MAX_NOTICES);
  for (const n of list) {
    if (!n || typeof n !== 'object' || typeof n.symbol !== 'string' || !bases.has(n.symbol)) continue;
    if (n.verdict !== 'RIPPLE' && n.verdict !== 'MISSED') continue;
    const ts = Number.isSafeInteger(n.tsMs) ? n.tsMs : null; // only an explicit integer notice clock counts; prose timestamps are never parsed here
    if (ts !== null && ts > nowMs) continue; // a notice from the future is not known yet
    const z = Number.isFinite(n.zVol) ? Math.abs(n.zVol) : null;
    const cur = byBase.get(n.symbol) ?? { base: n.symbol, priority: 1, reasons: [], lastNoticeTs: null, zVol: null, verdicts: [] };
    const tag = n.verdict === 'RIPPLE' ? 'RIPPLE_NOTICE' : 'MISSED_NOTICE';
    if (!cur.reasons.includes(tag)) cur.reasons.push(tag);
    if (cur.priority !== 0) cur.priority = Math.min(cur.priority, n.verdict === 'RIPPLE' ? 1 : 2);
    if (ts !== null && (cur.lastNoticeTs === null || ts > cur.lastNoticeTs)) cur.lastNoticeTs = ts;
    if (z !== null && (cur.zVol === null || z > cur.zVol)) cur.zVol = z;
    if (!cur.verdicts.includes(n.verdict)) cur.verdicts.push(n.verdict);
    byBase.set(n.symbol, cur);
  }
  const ranked = [...byBase.values()].sort((a, b) => a.priority - b.priority || cmp(b.lastNoticeTs ?? -1, a.lastNoticeTs ?? -1) || cmp(b.zVol ?? -1, a.zVol ?? -1) || cmp(a.base, b.base));
  const selected = ranked.slice(0, cap).map((c) => ({ base: c.base, reasons: [...c.reasons].sort(), lastNoticeTs: c.lastNoticeTs, zVol: c.zVol, verdicts: [...c.verdicts].sort() }));
  const deferred = ranked.slice(cap).map((c) => ({ base: c.base, reason: 'RESOURCE_CAP', reasons: [...c.reasons].sort() }));
  const selectedSet = new Set(selected.map((s) => s.base)); const deferredSet = new Set(deferred.map((d) => d.base));
  const noSignal = [...bases].filter((b) => !selectedSet.has(b) && !deferredSet.has(b)).length; // still discoverable locally — not rejected, not ranked
  const plan = {
    version: WATCH_PLAN_VERSION, status: WATCH_PLAN_STATUS, createdTs: nowMs, catalogContentId: catalog.contentId, policy: { priority: [...WATCH_PLAN_PRIORITY], cap, capSource: cap === capBase ? 'DEFAULT_OR_CONFIG' : 'OPERATOR_STRICTER' },
    selected, deferred, resourceCoverage: { catalogSupported: bases.size, selected: selected.length, deferred: deferred.length, noResearchSignalYet: noSignal, cap },
    authority: 'NONE', appliesPaidRules: false, // PROPOSED only; an explicit operator scope through configuration is the only path to a rule set
  };
  return { plan: deepFreeze({ ...plan, planId: contentHash(canonicalJson({ version: plan.version, catalogContentId: plan.catalogContentId, selected: plan.selected.map((s) => s.base), deferred: plan.deferred.map((d) => d.base), cap })) }) };
}
