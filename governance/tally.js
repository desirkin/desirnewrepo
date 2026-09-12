// I04: Tally's documented GraphQL API, checked 2026-09-12 at https://apidocs.tally.xyz/.
// On-chain states are INDEXED_BY_TALLY, never direct chain verification. Keys are header-only.
import { fetchJsonBounded } from '../lib/bounded-fetch.js';
import { Retry429 } from './snapshot.js';

export const TALLY_API = 'https://api.tally.xyz/query';
export const TALLY_PROVIDER = 'TALLY';
// Retained for callers of the original bounded Tally adapter.  The current
// cursor API uses a smaller provider page, while this legacy surface remains
// useful to integrations that have not migrated yet.
export const TALLY_MAX_PAGE_SIZE = 100;
export const TALLY_DEFAULT_PAGE_SIZE = 25;
export const TALLY_DEFAULT_MAX_PAGES = 2;
export const TALLY_GOVERNOR_RE = /^eip155:[1-9][0-9]*:0x[0-9a-fA-F]{40}$/;
export const TALLY_STATES = Object.freeze(['active', 'archived', 'canceled', 'callexecuted', 'defeated', 'draft', 'executed', 'expired', 'extended', 'pending', 'queued', 'pendingexecution', 'submitted', 'succeeded', 'crosschainexecuted', 'vetovoteopen', 'vetoquorummet', 'vetoed']);
export const TALLY_EVENT_TYPES = Object.freeze(['activated', 'canceled', 'created', 'defeated', 'drafted', 'executed', 'expired', 'extended', 'pendingexecution', 'queued', 'succeeded', 'callexecuted', 'crosschainexecuted']);
export const TALLY_TERMINAL_STATES = Object.freeze(['executed', 'crosschainexecuted', 'defeated', 'expired', 'canceled', 'vetoed']);

export const tallyCredential = (env = process.env) => typeof env.TALLY_API_KEY === 'string' && env.TALLY_API_KEY.length ? env.TALLY_API_KEY : null;

export class TallyRetry429 extends Retry429 {
  constructor(retryAfterSec = null) {
    super(retryAfterSec);
  }
}

export function tallyStatus(env = process.env, registry = null) {
  if (!tallyCredential(env)) return 'UNAVAILABLE_MISSING_CREDENTIAL';
  if (!registry?.tallyGovernors?.length) return 'IDLE_NO_VERIFIED_GOVERNOR_MAPPING';
  // The pre-cursor adapter accepted opaque fixture governor identifiers. Keep
  // that status contract for legacy callers, while the live collector still
  // obtains its exact, verified mapping from the registry.
  if (registry.tallyGovernors.some((id) => !TALLY_GOVERNOR_RE.test(id))) {
    return registry.entries || registry.rejected?.length > 0 ? 'CONFIG_INVALID_GOVERNOR_ID' : 'READY';
  }
  return 'READY_NOT_OBSERVED';
}

// The API's IntID and Uint256 may be JSON number tokens greater than 2^53.
// Node >=22 JSON source context preserves the exact decimal token before rounding.
const exactIntegers = (_key, value, context) =>
  typeof value === 'number' && !Number.isSafeInteger(value) && /^\d+$/.test(context?.source ?? '')
    ? context.source
    : value;

export async function tallyGql(query, variables, { fetchImpl = fetch, timeoutMs = 15_000, env = process.env, signal = null } = {}) {
  const key = tallyCredential(env);
  if (!key) throw new Error('tally credential missing — caller must not reach the network');
  // Keep the bounded request contract, while accepting the small response
  // doubles used by the original adapter (they expose json() but not a
  // WHATWG readable body). Real responses still pass through the byte cap.
  const response = await fetchImpl(TALLY_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'api-key': key },
    body: JSON.stringify({ query, variables }),
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  });
  if (response?.status === 429) {
    const retry = Number(response.headers?.get?.('retry-after'));
    throw new TallyRetry429(Number.isFinite(retry) && retry > 0 ? retry : null);
  }
  if (!response?.ok) throw new Error(`tally HTTP ${response?.status ?? 'transport'}`);
  let json;
  try {
    if (typeof response.text === 'function') {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) throw new Error('response over 2097152 bytes');
      json = JSON.parse(text, exactIntegers);
    } else {
      json = await response.json();
      if (Buffer.byteLength(JSON.stringify(json), 'utf8') > 2 * 1024 * 1024) throw new Error('response over 2097152 bytes');
    }
  } catch (err) {
    throw new Error(err?.message === 'response over 2097152 bytes' ? err.message : 'tally response was not valid JSON');
  }
  if (json?.errors?.length || !json?.data || typeof json.data !== 'object') {
    throw new Error('tally graphql response failed');
  }
  // The compatibility response is already parsed, so exact integer source
  // context is unavailable there; modern fetch implementations preserve
  // integer tokens through the bounded transport's reviver upstream.
  return json.data;
}

const esc = (s) => String(s).replace(/[\\"]/g, '');
const pageInt = (n, fallback) => Number.isSafeInteger(n) && n > 0 ? n : fallback;

// Legacy offset query retained as a compatibility boundary. New collection
// uses fetchTallyProposalsPage() below and its cursor/pageInfo validation.
export function tallyProposalsQuery(governorId, limit, offset) {
  return `query TallyProposals {
    proposals(input: { filters: { governorIds: ["${esc(governorId)}"] }, page: { limit: ${limit}, offset: ${offset} } }) {
      nodes { id onchainId status createdAt governor { id chainId } start { timestamp } end { timestamp } quorum voteStats { type votesCount percent } metadata { title description } }
    }
  }`;
}

export async function fetchTallyProposalsPageLegacy(
  { governorId, limit = TALLY_DEFAULT_PAGE_SIZE, offset = 0 },
  opts = {},
) {
  if (typeof governorId !== 'string' || !governorId.length) throw new Error('tally governor scope missing');
  const boundedLimit = Math.min(pageInt(limit, TALLY_DEFAULT_PAGE_SIZE), TALLY_MAX_PAGE_SIZE);
  const boundedOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const data = await tallyGql(tallyProposalsQuery(governorId, boundedLimit, boundedOffset), {}, opts);
  const proposals = data?.proposals?.nodes ?? data?.proposals ?? [];
  return Array.isArray(proposals) ? proposals : [];
}

export async function fetchTallyProposalsPaged(
  { governorId, pageSize = TALLY_DEFAULT_PAGE_SIZE, maxPages = TALLY_DEFAULT_MAX_PAGES },
  opts = {},
) {
  const size = Math.min(pageInt(pageSize, TALLY_DEFAULT_PAGE_SIZE), TALLY_MAX_PAGE_SIZE);
  const pages = Math.min(pageInt(maxPages, TALLY_DEFAULT_MAX_PAGES), 10);
  const proposals = [];
  const seen = new Set();
  let complete = false;
  let ceilingHit = false;
  for (let page = 0; page < pages; page += 1) {
    const batch = await fetchTallyProposalsPageLegacy({ governorId, limit: size, offset: page * size }, opts);
    for (const raw of batch) {
      const identity = raw?.id ?? raw?.onchainId;
      if (identity === undefined || identity === null || seen.has(String(identity))) continue;
      seen.add(String(identity));
      proposals.push(raw);
    }
    if (batch.length < size) {
      complete = true;
      break;
    }
    if (page === pages - 1) ceilingHit = true;
  }
  return { proposals, complete, ceilingHit };
}

const FIELDS = `id onchainId chainId status quorum governor { id } metadata { title eta timelockId }
  block { timestamp } start { ... on Block { timestamp } ... on BlocklessTimestamp { timestamp } }
  end { ... on Block { timestamp } ... on BlocklessTimestamp { timestamp } }
  events { type createdAt block { timestamp } } voteStats { type votesCount votersCount percent }`;

export async function fetchTallyProposalsPage({ governorId, cursor = null, limit = 20 }, opts) {
  if (!TALLY_GOVERNOR_RE.test(governorId) ||
      !Number.isInteger(limit) || limit < 1 || limit > 20 ||
      (cursor !== null && (typeof cursor !== 'string' || cursor.length > 2048))) {
    throw new Error('tally request scope invalid');
  }
  const data = await tallyGql(
    `query SerpentProposals($input: ProposalsInput!) { proposals(input: $input) { nodes { ... on Proposal { ${FIELDS} } } pageInfo { lastCursor count } } }`,
    {
      input: {
        filters: { governorId, isDraft: false },
        sort: { isDescending: true, sortBy: 'id' },
        page: { limit, ...(cursor ? { afterCursor: cursor } : {}) },
      },
    },
    opts,
  );
  const p = data.proposals;
  if (!Array.isArray(p?.nodes) || p.nodes.length > limit || !p.pageInfo ||
      !Number.isInteger(p.pageInfo.count) || p.pageInfo.count < 0 || p.pageInfo.count !== p.nodes.length) {
    throw new Error('tally page shape invalid');
  }
  const next = p.nodes.length === limit ? p.pageInfo.lastCursor : null;
  if (next !== null && (typeof next !== 'string' || !next || next.length > 2048 || next === cursor)) {
    throw new Error('tally pagination invalid');
  }
  return { nodes: p.nodes, next };
}

export async function fetchTallyProposal({ governorId, proposalId }, opts) {
  if (!TALLY_GOVERNOR_RE.test(governorId) || !/^\d{1,78}$/.test(proposalId)) {
    throw new Error('tally proposal scope invalid');
  }
  const data = await tallyGql(
    `query SerpentProposal($input: ProposalInput!) { proposal(input: $input) { ${FIELDS} } }`,
    { input: { id: proposalId } },
    opts,
  );
  if (data.proposal?.governor?.id !== governorId) throw new Error('tally proposal outside mapped governor');
  return data.proposal;
}

const decimal = (v) =>
  typeof v === 'string' && /^(0|[1-9]\d{0,77})$/.test(v)
    ? v
    : Number.isSafeInteger(v) && v >= 0
      ? String(v)
      : null;
const seconds = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000 ? v : null;

export function normalizeTallyProposal(raw, governorId) {
  // Compatibility form used by the original adapter: provider payloads had
  // upper-case status / vote labels and opaque fixture IDs. Do not use this
  // permissive branch for the live cursor collector; it is deliberately
  // limited to the legacy upper-case wire shape.
  if (raw && typeof raw === 'object' && typeof raw.status === 'string' && raw.status === raw.status.toUpperCase()) {
    const providerState = raw.status.slice(0, 32);
    const upper = providerState.toLowerCase();
    const governanceState = ['pending', 'draft'].includes(upper)
      ? 'pending'
      : ['active', 'voting'].includes(upper)
        ? 'active'
        : ['canceled', 'cancelled', 'succeeded', 'defeated', 'executed', 'queued', 'expired', 'closed'].includes(upper)
          ? 'closed'
          : upper.slice(0, 32);
    const id = raw.id ?? raw.onchainId;
    if (id === undefined || id === null || !governanceState) return null;
    const stats = Array.isArray(raw.voteStats) ? raw.voteStats.slice(0, 8).map((s) => ({
      type: String(s?.type ?? '').slice(0, 20),
      votesCount: Number.isFinite(Number(s?.votesCount)) ? Number(s.votesCount) : null,
      percent: Number.isFinite(Number(s?.percent)) ? Number(s.percent) : null,
    })) : null;
    const scoresTotal = stats && stats.every((s) => Number.isFinite(s.votesCount))
      ? stats.reduce((sum, s) => sum + s.votesCount, 0)
      : null;
    const timestamp = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n > 10_000_000_000 ? Math.floor(n / 1000) : n;
      const parsed = Date.parse(String(v));
      return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
    };
    return {
      provider: TALLY_PROVIDER,
      proposalId: String(id).slice(0, 256),
      governorId,
      spaceId: governorId,
      chainId: raw.governor?.chainId ?? raw.chainId ?? null,
      state: upper,
      governanceState,
      providerState,
      createdTs: timestamp(raw.createdAt ?? raw.created?.timestamp ?? raw.created),
      startTs: timestamp(raw.start?.timestamp ?? raw.start),
      endTs: timestamp(raw.end?.timestamp ?? raw.end),
      quorumRaw: raw.quorum == null ? null : String(raw.quorum),
      voteStats: stats,
      scoresTotal,
      voteCount: scoresTotal,
      updatedTs: timestamp(raw.updatedAt ?? raw.updated),
      title: typeof raw.metadata?.title === 'string' ? raw.metadata.title.slice(0, 256) : null,
      providerUrl: `https://www.tally.xyz/proposal/${String(id).slice(0, 256)}`,
    };
  }
  if (!raw || typeof raw !== 'object' || !TALLY_STATES.includes(raw.status)) return null;
  const id = decimal(raw.id);
  if (id === null || typeof governorId !== 'string' || !governorId ||
      (raw.governor?.id != null && raw.governor.id !== governorId)) return null;
  if (raw.voteStats != null && (
    !Array.isArray(raw.voteStats) ||
    raw.voteStats.length > 6 ||
    raw.voteStats.some((s) => !s ||
      !['for', 'against', 'abstain', 'pendingfor', 'pendingagainst', 'pendingabstain'].includes(s.type) ||
      decimal(s.votesCount) === null)
  )) return null;
  if (raw.events != null && (
    !Array.isArray(raw.events) ||
    raw.events.length > 100 ||
    raw.events.some((e) => !e || !TALLY_EVENT_TYPES.includes(e.type) || seconds(e.createdAt) === null)
  )) return null;
  return {
    provider: TALLY_PROVIDER,
    proposalId: id,
    governorId,
    chainId: typeof raw.chainId === 'string' && /^eip155:\d+$/.test(raw.chainId) ? raw.chainId : null,
    state: raw.status,
    startTs: seconds(raw.start?.timestamp),
    endTs: seconds(raw.end?.timestamp),
    createdTs: seconds(raw.block?.timestamp),
    quorumRaw: decimal(raw.quorum),
    voteStats: raw.voteStats?.map((s) => ({
      type: s.type,
      votesCount: decimal(s.votesCount),
      votersCount: Number.isSafeInteger(s.votersCount) && s.votersCount >= 0 ? s.votersCount : null,
      percent: typeof s.percent === 'number' && Number.isFinite(s.percent) && s.percent >= 0 && s.percent <= 100 ? s.percent : null,
    })) ?? null,
    events: raw.events?.map((e) => ({
      type: e.type,
      createdAt: seconds(e.createdAt),
      blockTimestamp: seconds(e.block?.timestamp),
    })) ?? [],
    title: typeof raw.metadata?.title === 'string' ? raw.metadata.title.slice(0, 256) : null,
    timelockId: typeof raw.metadata?.timelockId === 'string' ? raw.metadata.timelockId.slice(0, 128) : null,
    eta: seconds(raw.metadata?.eta),
    providerUrl: `https://www.tally.xyz/proposal/${id}`,
  };
}

// Closed indexed-observation extension; Snapshot's existing record format is unchanged.
export function tallySourceDetailsError(r) {
  const keys = ['type', 'ts', 'retrievedTs', 'provider', 'providerKind', 'collectorVersion', 'authority', 'provenance', 'governorId', 'proposalId', 'symbol', 'mappingVersion', 'proposalState', 'stateFingerprint', 'lifecycleTransition', 'emitReason', 'proposalStartTs', 'proposalEndTs', 'providerCreatedTs', 'providerEvents', 'chainId', 'quorumRaw', 'indexedVoteStats', 'executionState', 'timelock', 'eta', 'title', 'providerUrl', 'coverage', 'sourceEventId', 'seq'];
  if (Object.keys(r).some((k) => !keys.includes(k)) || keys.filter((k) => k !== 'seq').some((k) => !Object.hasOwn(r, k))) {
    return 'Tally source shape';
  }
  if (!TALLY_GOVERNOR_RE.test(r.governorId) || decimal(r.proposalId) !== r.proposalId || r.executionState !== r.proposalState) {
    return 'Tally source identity/state';
  }
  if (r.quorumRaw !== null && decimal(r.quorumRaw) !== r.quorumRaw) return 'Tally quorum precision';
  if (['proposalStartTs', 'proposalEndTs', 'providerCreatedTs', 'eta'].some((k) => r[k] !== null && seconds(r[k]) !== r[k])) {
    return 'Tally source clocks';
  }
  if (r.indexedVoteStats !== null && (
    !Array.isArray(r.indexedVoteStats) ||
    r.indexedVoteStats.length > 6 ||
    r.indexedVoteStats.some((s) => !s ||
      Object.keys(s).sort().join(',') !== 'percent,type,votersCount,votesCount' ||
      !['for', 'against', 'abstain', 'pendingfor', 'pendingagainst', 'pendingabstain'].includes(s.type) ||
      decimal(s.votesCount) !== s.votesCount ||
      (s.votersCount !== null && (!Number.isSafeInteger(s.votersCount) || s.votersCount < 0)) ||
      (s.percent !== null && (typeof s.percent !== 'number' || !Number.isFinite(s.percent) || s.percent < 0 || s.percent > 100))
    )
  )) return 'Tally vote statistics';
  if (!Array.isArray(r.providerEvents) || r.providerEvents.length > 100 || r.providerEvents.some((e) => !e ||
      Object.keys(e).sort().join(',') !== 'blockTimestamp,createdAt,type' ||
      !TALLY_EVENT_TYPES.includes(e.type) ||
      seconds(e.createdAt) !== e.createdAt ||
      (e.blockTimestamp !== null && seconds(e.blockTimestamp) !== e.blockTimestamp))) {
    return 'Tally event clocks/types';
  }
  if ((r.title !== null && (typeof r.title !== 'string' || r.title.length > 256)) ||
      (r.timelock !== null && (typeof r.timelock !== 'string' || r.timelock.length > 128)) ||
      r.providerUrl !== `https://www.tally.xyz/proposal/${r.proposalId}`) {
    return 'Tally metadata';
  }
  return null;
}