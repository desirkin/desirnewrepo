// I04: Tally's documented GraphQL API, checked 2026-09-12 at https://apidocs.tally.xyz/.
// On-chain states are INDEXED_BY_TALLY, never direct chain verification. Keys are header-only.
import { fetchJsonBounded } from '../lib/bounded-fetch.js';
import { Retry429 } from './snapshot.js';
export const TALLY_API = 'https://api.tally.xyz/query';
export const TALLY_PROVIDER = 'TALLY';
export const TALLY_GOVERNOR_RE = /^eip155:[1-9][0-9]*:0x[0-9a-fA-F]{40}$/;
export const TALLY_STATES = Object.freeze(['active', 'archived', 'canceled', 'callexecuted', 'defeated', 'draft', 'executed', 'expired', 'extended', 'pending', 'queued', 'pendingexecution', 'submitted', 'succeeded', 'crosschainexecuted', 'vetovoteopen', 'vetoquorummet', 'vetoed']);
export const TALLY_EVENT_TYPES = Object.freeze(['activated','canceled','created','defeated','drafted','executed','expired','extended','pendingexecution','queued','succeeded','callexecuted','crosschainexecuted']);
export const TALLY_TERMINAL_STATES = Object.freeze(['executed', 'crosschainexecuted', 'defeated', 'expired', 'canceled', 'vetoed']);
export const tallyCredential = (env = process.env) => typeof env.TALLY_API_KEY === 'string' && env.TALLY_API_KEY.length ? env.TALLY_API_KEY : null;
export function tallyStatus(env = process.env, registry = null) {
  if (!tallyCredential(env)) return 'UNAVAILABLE_MISSING_CREDENTIAL';
  if (!registry?.tallyGovernors.length) return 'IDLE_NO_VERIFIED_GOVERNOR_MAPPING';
  if (registry.tallyGovernors.some(id => !TALLY_GOVERNOR_RE.test(id))) return 'CONFIG_INVALID_GOVERNOR_ID';
  return 'READY_NOT_OBSERVED';
}
// The API's IntID and Uint256 may be JSON number tokens greater than 2^53.
// Node >=22 JSON source context preserves the exact decimal token before rounding.
const exactIntegers = (_key, value, context) => typeof value === 'number' && !Number.isSafeInteger(value) && /^\d+$/.test(context?.source ?? '') ? context.source : value;
export async function tallyGql(query, variables, { fetchImpl = fetch, timeoutMs = 15000, env = process.env, signal = null } = {}) {
  const key = tallyCredential(env); if (!key) throw new Error('tally credential missing — caller must not reach the network');
  const r = await fetchJsonBounded(TALLY_API, { host: 'api.tally.xyz', method: 'POST', fetchImpl, timeoutMs, signal, headers: { 'content-type': 'application/json', 'api-key': key }, body: JSON.stringify({ query, variables }), jsonReviver: exactIntegers });
  if (r.outcome === 'RATE_LIMITED') throw new Retry429(Math.min(86400, r.retryAfterSec ?? 900));
  if (r.outcome !== 'OK') throw new Error(`tally ${r.reason ?? r.outcome}`);
  if (r.json?.errors?.length || !r.json?.data || typeof r.json.data !== 'object') throw new Error('tally graphql response failed');
  return r.json.data;
}
const FIELDS = `id onchainId chainId status quorum governor { id } metadata { title eta timelockId }
  block { timestamp } start { ... on Block { timestamp } ... on BlocklessTimestamp { timestamp } }
  end { ... on Block { timestamp } ... on BlocklessTimestamp { timestamp } }
  events { type createdAt block { timestamp } } voteStats { type votesCount votersCount percent }`;
export async function fetchTallyProposalsPage({ governorId, cursor = null, limit = 20 }, opts) {
  if (!TALLY_GOVERNOR_RE.test(governorId) || !Number.isInteger(limit) || limit < 1 || limit > 20 || (cursor !== null && (typeof cursor !== 'string' || cursor.length > 2048))) throw new Error('tally request scope invalid');
  const data = await tallyGql(`query SerpentProposals($input: ProposalsInput!) { proposals(input: $input) { nodes { ... on Proposal { ${FIELDS} } } pageInfo { lastCursor count } } }`, { input: { filters: { governorId, isDraft: false }, sort: { isDescending: true, sortBy: 'id' }, page: { limit, ...(cursor ? { afterCursor: cursor } : {}) } } }, opts);
  const p = data.proposals;
  if (!Array.isArray(p?.nodes) || p.nodes.length > limit || !p.pageInfo || !Number.isInteger(p.pageInfo.count) || p.pageInfo.count < 0 || p.pageInfo.count !== p.nodes.length) throw new Error('tally page shape invalid');
  const next = p.nodes.length === limit ? p.pageInfo.lastCursor : null;
  if (next !== null && (typeof next !== 'string' || !next || next.length > 2048 || next === cursor)) throw new Error('tally pagination invalid');
  return { nodes: p.nodes, next };
}
export async function fetchTallyProposal({ governorId, proposalId }, opts) {
  if (!TALLY_GOVERNOR_RE.test(governorId) || !/^\d{1,78}$/.test(proposalId)) throw new Error('tally proposal scope invalid');
  const data = await tallyGql(`query SerpentProposal($input: ProposalInput!) { proposal(input: $input) { ${FIELDS} } }`, { input: { id: proposalId } }, opts);
  if (data.proposal?.governor?.id !== governorId) throw new Error('tally proposal outside mapped governor');
  return data.proposal;
}
const decimal = v => typeof v === 'string' && /^(0|[1-9]\d{0,77})$/.test(v) ? v : Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
const seconds = v => Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000 ? v : null;
export function normalizeTallyProposal(raw, governorId) {
  if (!raw || typeof raw !== 'object' || !TALLY_STATES.includes(raw.status)) return null;
  const id = decimal(raw.id); if (id === null || typeof governorId !== 'string' || !governorId || (raw.governor?.id != null && raw.governor.id !== governorId)) return null;
  if (raw.voteStats != null && (!Array.isArray(raw.voteStats) || raw.voteStats.length > 6 || raw.voteStats.some(s => !s || !['for','against','abstain','pendingfor','pendingagainst','pendingabstain'].includes(s.type) || decimal(s.votesCount) === null))) return null;
  if (raw.events != null && (!Array.isArray(raw.events) || raw.events.length > 100 || raw.events.some(e => !e || !TALLY_EVENT_TYPES.includes(e.type) || seconds(e.createdAt) === null))) return null;
  return { provider: TALLY_PROVIDER, proposalId: id, governorId, chainId: typeof raw.chainId === 'string' && /^eip155:\d+$/.test(raw.chainId) ? raw.chainId : null, state: raw.status,
    startTs: seconds(raw.start?.timestamp), endTs: seconds(raw.end?.timestamp), createdTs: seconds(raw.block?.timestamp), quorumRaw: decimal(raw.quorum),
    voteStats: raw.voteStats?.map(s => ({ type: s.type, votesCount: decimal(s.votesCount), votersCount: Number.isSafeInteger(s.votersCount) && s.votersCount >= 0 ? s.votersCount : null, percent: typeof s.percent === 'number' && Number.isFinite(s.percent) && s.percent >= 0 && s.percent <= 100 ? s.percent : null })) ?? null,
    events: raw.events?.map(e => ({ type: e.type, createdAt: seconds(e.createdAt), blockTimestamp: seconds(e.block?.timestamp) })) ?? [],
    title: typeof raw.metadata?.title === 'string' ? raw.metadata.title.slice(0, 256) : null,
    timelockId: typeof raw.metadata?.timelockId === 'string' ? raw.metadata.timelockId.slice(0, 128) : null, eta: seconds(raw.metadata?.eta), providerUrl: `https://www.tally.xyz/proposal/${id}` };
}

// Closed indexed-observation extension; Snapshot's existing record format is unchanged.
export function tallySourceDetailsError(r) {
  const keys=['type','ts','retrievedTs','provider','providerKind','collectorVersion','authority','provenance','governorId','proposalId','symbol','mappingVersion','proposalState','stateFingerprint','lifecycleTransition','emitReason','proposalStartTs','proposalEndTs','providerCreatedTs','providerEvents','chainId','quorumRaw','indexedVoteStats','executionState','timelock','eta','title','providerUrl','coverage','sourceEventId','seq'];
  if(Object.keys(r).some(k=>!keys.includes(k))||keys.filter(k=>k!=='seq').some(k=>!Object.hasOwn(r,k)))return 'Tally source shape';
  if(!TALLY_GOVERNOR_RE.test(r.governorId)||decimal(r.proposalId)!==r.proposalId||r.executionState!==r.proposalState)return 'Tally source identity/state';
  if(r.quorumRaw!==null&&decimal(r.quorumRaw)!==r.quorumRaw)return 'Tally quorum precision';
  if(['proposalStartTs','proposalEndTs','providerCreatedTs','eta'].some(k=>r[k]!==null&&seconds(r[k])!==r[k]))return 'Tally source clocks';
  if(r.indexedVoteStats!==null&&(!Array.isArray(r.indexedVoteStats)||r.indexedVoteStats.length>6||r.indexedVoteStats.some(s=>!s||Object.keys(s).sort().join(',')!=='percent,type,votersCount,votesCount'||!['for','against','abstain','pendingfor','pendingagainst','pendingabstain'].includes(s.type)||decimal(s.votesCount)!==s.votesCount||(s.votersCount!==null&&(!Number.isSafeInteger(s.votersCount)||s.votersCount<0))||(s.percent!==null&&(typeof s.percent!=='number'||!Number.isFinite(s.percent)||s.percent<0||s.percent>100)))))return 'Tally vote statistics';
  if(!Array.isArray(r.providerEvents)||r.providerEvents.length>100||r.providerEvents.some(e=>!e||Object.keys(e).sort().join(',')!=='blockTimestamp,createdAt,type'||!TALLY_EVENT_TYPES.includes(e.type)||seconds(e.createdAt)!==e.createdAt||(e.blockTimestamp!==null&&seconds(e.blockTimestamp)!==e.blockTimestamp)))return 'Tally event clocks/types';
  if((r.title!==null&&(typeof r.title!=='string'||r.title.length>256))||(r.timelock!==null&&(typeof r.timelock!=='string'||r.timelock.length>128))||r.providerUrl!==`https://www.tally.xyz/proposal/${r.proposalId}`)return 'Tally metadata';
  return null;
}
