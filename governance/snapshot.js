// GOV-1 — Snapshot Hub provider client. OFF-CHAIN governance/voting
// evidence, and it says so: a Snapshot proposal that passes proves a vote
// PASSED_OFFCHAIN_VOTE — never that code executed, a treasury moved, a
// timelock started, or an outcome is inevitable. Bounded GraphQL only;
// injectable fetch for tests; proposal text is UNTRUSTED DATA that is
// stored bounded and never executed or interpreted.
import { createHash } from 'node:crypto';

export const SNAPSHOT_HUB = 'https://hub.snapshot.org/graphql';
export const SNAPSHOT_PROVIDER = 'SNAPSHOT';

// Canonical FOR/AGAINST choice recognition: EXACT labels only (case
// blind). Anything else keeps scoresByChoice verbatim and support ratios
// UNKNOWN — choice-label similarity is a guess and guesses are refused.
const CANONICAL_FOR = new Set(['for', 'yes', 'yae', 'yay']);
const CANONICAL_AGAINST = new Set(['against', 'no', 'nay']);
const CANONICAL_ABSTAIN = new Set(['abstain']);

export class Retry429 extends Error {
  constructor(retryAfterSec) {
    super('HTTP 429');
    this.retryAfterSec = retryAfterSec;
  }
}

// One bounded GraphQL POST. Throws Retry429 on rate limiting (carrying
// Retry-After when the provider names one) and Error otherwise.
export async function snapshotGql(query, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const res = await fetchImpl(SNAPSHOT_HUB, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429) {
    const ra = Number(res.headers?.get?.('retry-after'));
    throw new Retry429(Number.isFinite(ra) && ra > 0 ? ra : null);
  }
  if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`snapshot graphql: ${body.errors.map((e) => e.message).join('; ')}`);
  return body.data;
}

const esc = (s) => String(s).replace(/[\\"]/g, ''); // ids are plain tokens; quotes/backslashes have no business here

// One page of proposals across ALL registry spaces at once (batched query,
// one request instead of one per space). `state` narrows server-side.
export async function fetchProposalsPage({ spaceIds, state, first, skip = 0 }, opts = {}) {
  const spaces = spaceIds.map((s) => `"${esc(s)}"`).join(', ');
  const stateClause = state ? `, state: "${esc(state)}"` : '';
  const q = `{ proposals(first: ${Math.floor(first)}, skip: ${Math.floor(skip)},
      where: { space_in: [${spaces}]${stateClause} }, orderBy: "created", orderDirection: desc) {
    id space { id } author title body state created start end quorum choices scores scores_total votes snapshot updated } }`;
  const data = await snapshotGql(q, opts);
  return data?.proposals ?? [];
}

// One bounded page of votes for one proposal.
export async function fetchVotesPage({ proposalId, first, skip = 0 }, opts = {}) {
  const q = `{ votes(first: ${Math.floor(first)}, skip: ${Math.floor(skip)},
      where: { proposal: "${esc(proposalId)}" }, orderBy: "vp", orderDirection: desc) {
    voter created choice vp } }`;
  const data = await snapshotGql(q, opts);
  return data?.votes ?? [];
}

const boundedText = (s, maxBytes) => {
  if (typeof s !== 'string') return null;
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  return buf.subarray(0, maxBytes).toString('utf8').replace(/�+$/, '');
};

// PURE normalization of one raw provider proposal into the bounded shape
// the collector observes. Malformed input returns null — refused, never
// repaired. Text stays data: bounded excerpt + content hash, nothing more.
export function normalizeProposal(raw, { maxTitleBytes = 256, maxBodyBytes = 2048 } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id.length) return null;
  const spaceId = raw.space?.id;
  if (typeof spaceId !== 'string' || !spaceId.length) return null;
  if (typeof raw.state !== 'string') return null;
  const num = (v) => (Number.isFinite(v) ? v : null);
  const body = typeof raw.body === 'string' ? raw.body : '';
  return {
    provider: SNAPSHOT_PROVIDER,
    proposalId: raw.id,
    spaceId,
    author: typeof raw.author === 'string' ? raw.author.slice(0, 100) : null,
    state: raw.state, // provider vocabulary: pending | active | closed
    createdTs: num(raw.created),
    startTs: num(raw.start),
    endTs: num(raw.end),
    snapshotBlock: raw.snapshot ?? null,
    updatedTs: num(raw.updated),
    quorumRaw: num(raw.quorum),
    choices: Array.isArray(raw.choices) ? raw.choices.slice(0, 32).map((c) => String(c).slice(0, 100)) : null,
    scores: Array.isArray(raw.scores) ? raw.scores.slice(0, 32).map((s) => (Number.isFinite(s) ? s : null)) : null,
    scoresTotal: num(raw.scores_total),
    voteCount: num(raw.votes),
    title: boundedText(raw.title ?? '', maxTitleBytes),
    bodyExcerpt: boundedText(body, maxBodyBytes),
    textHash: createHash('sha1').update(`${raw.title ?? ''}\n${body}`).digest('hex'),
    providerUrl: `https://snapshot.org/#/${spaceId}/proposal/${raw.id}`,
  };
}

// QUORUM TRUTH (pure): Snapshot's proposal.quorum and scores_total are both
// denominated in the space's own voting power, so progress is defensible
// ONLY when the provider supplies a positive quorum. Anything else is
// UNKNOWN — never zero, never a sum invented from votes.
export function quorumTruth(p) {
  if (!p || !Number.isFinite(p.quorumRaw) || p.quorumRaw <= 0 || !Number.isFinite(p.scoresTotal)) return 'UNKNOWN';
  return {
    quorumRequired: p.quorumRaw,
    quorumObserved: p.scoresTotal,
    quorumProgressRatio: Number((p.scoresTotal / p.quorumRaw).toFixed(6)),
    unit: 'space voting power (provider-defined strategies)',
  };
}

// VOTE TRAJECTORY (pure, descriptive): measurements only — never momentum,
// never confidence, never a prediction. Support/opposition ratios exist
// ONLY when the choice labels are exactly canonical For/Against(/Abstain);
// otherwise the verbatim per-choice scores stand alone.
export function voteTrajectory(p, nowSec, prev = null) {
  if (!p || !Array.isArray(p.choices) || !Array.isArray(p.scores)) return 'UNKNOWN';
  const byChoice = {};
  for (let i = 0; i < p.choices.length; i++) byChoice[p.choices[i]] = p.scores[i] ?? null;
  const total = Number.isFinite(p.scoresTotal) ? p.scoresTotal : null;
  let forPower = null;
  let againstPower = null;
  let abstainPower = null;
  for (let i = 0; i < p.choices.length; i++) {
    const label = String(p.choices[i]).trim().toLowerCase();
    if (CANONICAL_FOR.has(label)) forPower = p.scores[i] ?? null;
    else if (CANONICAL_AGAINST.has(label)) againstPower = p.scores[i] ?? null;
    else if (CANONICAL_ABSTAIN.has(label)) abstainPower = p.scores[i] ?? null;
  }
  const ratios =
    forPower !== null && againstPower !== null && total > 0
      ? { supportRatio: Number((forPower / total).toFixed(6)), oppositionRatio: Number((againstPower / total).toFixed(6)) }
      : { supportRatio: 'UNKNOWN', oppositionRatio: 'UNKNOWN' };
  return {
    scoresByChoice: byChoice,
    totalObservedPower: total,
    forPower,
    againstPower,
    abstainPower,
    ...ratios,
    observedVoterCount: Number.isFinite(p.voteCount) ? p.voteCount : null,
    timeRemainingSec: Number.isFinite(p.endTs) && Number.isFinite(nowSec) ? Math.max(0, p.endTs - nowSec) : null,
    // descriptive deltas against the PRIOR observation of the same proposal
    votingPowerDelta: prev && Number.isFinite(prev.scoresTotal) && Number.isFinite(total) ? Number((total - prev.scoresTotal).toFixed(6)) : null,
    voterCountDelta:
      prev && Number.isFinite(prev.voteCount) && Number.isFinite(p.voteCount) ? p.voteCount - prev.voteCount : null,
  };
}

// VOTER/DELEGATE CONCENTRATION (pure, descriptive) over the votes actually
// FETCHED under the page budget. When pagination is incomplete the metric
// truthfully describes the observed votes, labeled coverage PARTIAL —
// never the complete electorate.
export function voterConcentration(votes, { pagesComplete, totalVoteCount = null } = {}) {
  const powers = (votes ?? []).map((v) => v.vp).filter((x) => Number.isFinite(x) && x >= 0);
  if (!powers.length) return { coverage: 'UNAVAILABLE', observedVoterCount: 0 };
  const sum = powers.reduce((a, b) => a + b, 0);
  if (sum <= 0) return { coverage: 'UNAVAILABLE', observedVoterCount: powers.length };
  const sorted = [...powers].sort((a, b) => b - a);
  const top = (n) => Number((sorted.slice(0, n).reduce((a, b) => a + b, 0) / sum).toFixed(6));
  const complete = pagesComplete === true && (totalVoteCount === null || powers.length >= totalVoteCount);
  return {
    coverage: complete ? 'COMPLETE' : 'PARTIAL',
    coverageReason: complete ? null : pagesComplete === true ? 'VOTE_POWER_FIELDS_MISSING_OR_COUNT_SHORT' : 'PARTIAL_PAGE_LIMIT',
    observedVoterCount: powers.length,
    top1VotingPowerShare: top(1),
    top5VotingPowerShare: top(5),
    observedPowerSum: sum,
  };
}
