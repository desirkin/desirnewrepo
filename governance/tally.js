// GOV-1 — Tally's official indexed GraphQL route.  The API key lives only in
// TALLY_API_KEY and a request is made only for an exact, verified governor
// mapping supplied by governance/registry.js.  Tally is indexed provider
// evidence, not a direct chain read.

export const TALLY_API = 'https://api.tally.xyz/query';
export const TALLY_PROVIDER = 'TALLY';
export const TALLY_MAX_PAGE_SIZE = 100;
export const TALLY_DEFAULT_PAGE_SIZE = 25;
export const TALLY_DEFAULT_MAX_PAGES = 2;

export class TallyRetry429 extends Error {
  constructor(retryAfterSec = null) {
    super('HTTP 429');
    this.retryAfterSec = retryAfterSec;
  }
}

export function tallyCredential(env = process.env) {
  const key = env?.TALLY_API_KEY;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

export function tallyStatus(env = process.env, registry = null) {
  if (!tallyCredential(env)) return 'UNAVAILABLE_MISSING_CREDENTIAL';
  if (!registry || registry.tallyGovernors.length === 0) return 'IDLE_NO_VERIFIED_GOVERNOR_MAPPING';
  return 'READY';
}

// One bounded Tally GraphQL POST. Callers MUST have checked the credential;
// the key travels only in the request header and is never part of an error.
export async function tallyGql(query, variables = {}, { fetchImpl = fetch, timeoutMs = 15_000, env = process.env } = {}) {
  const key = tallyCredential(env);
  if (!key) throw new Error('tally credential missing — caller must not reach the network');
  let res;
  try {
    res = await fetchImpl(TALLY_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'api-key': key },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`tally network failure: ${err?.message ?? 'unknown'}`);
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers?.get?.('retry-after'));
    throw new TallyRetry429(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
  }
  if (!res.ok) throw new Error(`tally HTTP ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('tally response was not valid JSON');
  }
  if (body?.errors?.length) throw new Error(`tally graphql error (${body.errors.length} error(s))`);
  return body?.data ?? null;
}

const esc = (s) => String(s).replace(/[\\"]/g, '');
const pageInt = (n, fallback) => Number.isSafeInteger(n) && n > 0 ? n : fallback;

// The input/filter/page form is Tally's documented machine-readable
// proposals route. Governor IDs are passed as exact scope, never discovered
// from titles, symbols, or a search endpoint.
export function tallyProposalsQuery(governorId, limit, offset) {
  return `query TallyProposals {
    proposals(input: { filters: { governorIds: ["${esc(governorId)}"] }, page: { limit: ${limit}, offset: ${offset} } }) {
      nodes {
        id onchainId status createdAt
        governor { id chainId }
        start { timestamp } end { timestamp }
        quorum
        voteStats { type votesCount percent }
        metadata { title description }
      }
    }
  }`;
}

export async function fetchTallyProposalsPage(
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

// Bounded, deterministic pagination. A full final page means the ceiling may
// have been reached; that is reported rather than claimed complete.
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
  for (let page = 0; page < pages; page++) {
    const batch = await fetchTallyProposalsPage({ governorId, limit: size, offset: page * size }, opts);
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

const stateOf = (raw) => {
  const s = String(raw?.status ?? '').toUpperCase();
  if (s === 'PENDING' || s === 'DRAFT') return 'pending';
  if (s === 'ACTIVE' || s === 'VOTING') return 'active';
  if (s === 'CANCELED' || s === 'CANCELLED') return 'cancelled';
  if (s === 'SUCCEEDED' || s === 'DEFEATED' || s === 'EXECUTED' || s === 'QUEUED' || s === 'EXPIRED' || s === 'CLOSED') return 'closed';
  return s ? s.toLowerCase().slice(0, 32) : null;
};

const timestamp = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n > 10_000_000_000 ? Math.floor(n / 1000) : n;
  const parsed = Date.parse(String(v));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
};

// PURE canonicalization of one Tally proposal. Provider status is preserved in
// providerState/state while governanceState supplies the common lifecycle
// vocabulary required by the collector's evidence contract.
export function normalizeTallyProposal(raw, governorId) {
  if (!raw || typeof raw !== 'object' || typeof governorId !== 'string' || !governorId.length) return null;
  const id = raw.id ?? raw.onchainId;
  if (id === undefined || id === null) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const stats = Array.isArray(raw.voteStats) ? raw.voteStats.slice(0, 8).map((s) => ({
    type: String(s?.type ?? '').slice(0, 20),
    votesCount: num(s?.votesCount),
    percent: num(s?.percent),
  })) : null;
  const voteCount = stats && stats.every((s) => Number.isFinite(s.votesCount))
    ? stats.reduce((sum, s) => sum + s.votesCount, 0)
    : null;
  const governanceState = stateOf(raw);
  if (!governanceState) return null;
  const providerState = typeof raw.status === 'string' ? raw.status.slice(0, 32) : null;
  return {
    provider: TALLY_PROVIDER,
    proposalId: String(id).slice(0, 256),
    governorId,
    spaceId: governorId,
    chainId: raw.governor?.chainId ?? raw.chainId ?? null,
    state: providerState ? providerState.toLowerCase() : governanceState,
    governanceState,
    providerState,
    createdTs: timestamp(raw.createdAt ?? raw.created?.timestamp ?? raw.created),
    startTs: timestamp(raw.start?.timestamp ?? raw.start),
    endTs: timestamp(raw.end?.timestamp ?? raw.end),
    updatedTs: timestamp(raw.updatedAt ?? raw.updated?.timestamp ?? raw.updated),
    quorumRaw: num(raw.quorum),
    choices: stats ? stats.map((s) => s.type) : null,
    scores: stats ? stats.map((s) => s.votesCount) : null,
    scoresTotal: voteCount,
    voteCount,
    voteStats: stats,
    title: typeof raw.metadata?.title === 'string' ? raw.metadata.title.slice(0, 256) : null,
    bodyExcerpt: typeof raw.metadata?.description === 'string' ? raw.metadata.description.slice(0, 2048) : null,
    providerUrl: `https://www.tally.xyz/proposal/${encodeURIComponent(String(id))}`,
  };
}