// Deep memory — rare events, B-0B honest edition.
// Governance via Snapshot's public GraphQL hub (paginated, never silently
// truncated; vote timelines retrieved where the source serves them).
// NO uncalibrated probability language: the old final-margin
// "STATISTICALLY_NEAR_CERTAIN" heuristic is gone. Tally needs an API key
// this project does not hold -> UNAVAILABLE, recorded.
import { nowIso } from '../lib/time.js';
import { parseStatuspage } from '../gateway/parse.js';
import { mfeMae, retBetween } from './store.js';

const SNAPSHOT_HUB = 'https://hub.snapshot.org/graphql';
const PROPOSAL_PAGE = 100;
const PROPOSAL_CEILING = 1000; // per space; hitting it is manifested as a gap
const VOTE_PAGE = 1000;
const VOTE_PAGES_PER_PROPOSAL = 3;

export const SNAPSHOT_SPACES = {
  UNI: 'uniswapgovernance.eth',
  CRV: 'curve.eth',
  AAVE: 'aave.eth',
  ARB: 'arbitrumfoundation.eth',
  OP: 'opcollective.eth',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(query, fetchImpl = fetch) {
  const res = await fetchImpl(SNAPSHOT_HUB, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data;
}

// Paginated proposal fetch: skip-based pages until exhausted or the explicit
// documented ceiling. Never silently stops at page one. Testable via
// injected fetch.
export async function fetchProposalsPaged(space, fetchImpl = fetch, pause = 1200) {
  const proposals = [];
  let ceilingHit = false;
  for (let skip = 0; skip < PROPOSAL_CEILING; skip += PROPOSAL_PAGE) {
    const q = `{ proposals(first: ${PROPOSAL_PAGE}, skip: ${skip}, where: { space: "${space}" }, orderBy: "created", orderDirection: desc) {
      id title state created start end quorum scores scores_total choices votes } }`;
    const data = await gql(q, fetchImpl);
    const page = data?.proposals ?? [];
    proposals.push(...page);
    if (page.length < PROPOSAL_PAGE) return { proposals, complete: true, ceilingHit: false };
    if (pause) await sleep(pause);
  }
  ceilingHit = true;
  return { proposals, complete: false, ceilingHit };
}

// Vote timeline for one proposal, paginated, bounded. Each vote carries its
// own public timestamp — that IS its availableTs.
export async function fetchVotesPaged(proposalId, fetchImpl = fetch, pause = 1200) {
  const votes = [];
  for (let page = 0; page < VOTE_PAGES_PER_PROPOSAL; page++) {
    const q = `{ votes(first: ${VOTE_PAGE}, skip: ${page * VOTE_PAGE}, where: { proposal: "${proposalId}" }, orderBy: "created", orderDirection: asc) {
      voter created choice vp } }`;
    const data = await gql(q, fetchImpl);
    const batch = data?.votes ?? [];
    votes.push(...batch);
    if (batch.length < VOTE_PAGE) return { votes, complete: true };
    if (pause) await sleep(pause);
  }
  return { votes, complete: false }; // page ceiling hit — recorded by caller
}

// Honest inevitability (B-0B §10): NO probability language without a
// calibrated model. Descriptive final-tally facts only, plus
// INEVITABILITY_UNKNOWN unless a mathematical proof basis actually exists
// (it does not, with Snapshot data alone — eligible power is not exposed).
export function analyzeLock(p) {
  const scores = p.scores ?? [];
  const closed = p.state === 'closed';
  const total = p.scores_total ?? 0;
  const sorted = [...scores].sort((a, b) => b - a);
  const margin = sorted.length >= 2 ? sorted[0] - sorted[1] : null;
  const marginPct = margin !== null && total > 0 ? (margin / total) * 100 : null;
  return {
    status: 'INEVITABILITY_UNKNOWN',
    lockTime: 'UNKNOWN',
    basis:
      'remaining ELIGIBLE voting power is not exposed by snapshot; MATHEMATICALLY_LOCKED requires proof that no permissible remaining vote configuration could change the outcome; probability-style certainty labels are reserved for a future historically calibrated model',
    descriptive: {
      finalWinningMargin: margin,
      finalWinningMarginPctOfCastPower: marginPct === null ? null : Number(marginPct.toFixed(2)),
      finalQuorumMet: p.quorum ? total >= p.quorum : null,
      voteCount: p.votes ?? null,
      finalScores: scores,
      FINAL_MARGIN_DECISIVE_UNCALIBRATED: closed && marginPct !== null ? marginPct > 20 : null,
    },
  };
}

// Deterministic quorum-reached reconstruction from a public vote timeline:
// cumulative voting power crosses the proposal's quorum. Facts only.
export function quorumReachedTs(votes, quorum) {
  if (!quorum || quorum <= 0) return 'UNKNOWN';
  let cum = 0;
  for (const v of votes) {
    if (!Number.isFinite(v.vp)) return 'UNKNOWN'; // partial power data -> no claim
    cum += v.vp;
    if (cum >= quorum) return v.created;
  }
  return 'NOT_REACHED_IN_RETRIEVED_TIMELINE';
}

export async function fetchGovernance(universeCoins, { fetchImpl = fetch, voteRequestBudget = 250, log = () => {} } = {}) {
  const spaces = universeCoins.filter((c) => SNAPSHOT_SPACES[c]).map((c) => ({ coin: c, space: SNAPSHOT_SPACES[c] }));
  const records = [];
  const gaps = [];
  let voteRequestsUsed = 0;
  let votesRetrieved = 0;
  let timelinesComplete = 0;
  let timelinesUnavailable = 0;

  for (const { coin, space } of spaces) {
    try {
      const { proposals, complete, ceilingHit } = await fetchProposalsPaged(space, fetchImpl);
      if (ceilingHit) gaps.push(`${coin}: proposal pagination ceiling ${PROPOSAL_CEILING} reached — history beyond it not retrieved`);
      log(`governance ${coin}/${space}: ${proposals.length} proposals (complete=${complete})`);
      for (const p of proposals) {
        let voteTimeline = 'UNAVAILABLE';
        let timelineComplete = null;
        let qReached = 'UNKNOWN';
        if (voteRequestsUsed < voteRequestBudget) {
          try {
            voteRequestsUsed++;
            const { votes, complete: vc } = await fetchVotesPaged(p.id, fetchImpl);
            voteRequestsUsed += Math.max(0, Math.ceil(votes.length / VOTE_PAGE) - 1);
            voteTimeline = votes.map((v) => ({
              voter: v.voter,
              created: v.created, // public vote timestamp = availableTs
              choice: v.choice,
              vp: v.vp ?? null,
            }));
            votesRetrieved += votes.length;
            timelineComplete = vc;
            timelinesComplete += vc ? 1 : 0;
            qReached = quorumReachedTs(votes, p.quorum);
          } catch (err) {
            voteTimeline = 'UNAVAILABLE';
            gaps.push(`${coin} proposal ${p.id}: vote timeline fetch failed (${err.message})`);
            timelinesUnavailable++;
          }
        } else {
          timelinesUnavailable++;
        }
        records.push({
          coin,
          space,
          proposalId: p.id,
          title: p.title,
          state: p.state,
          timeline: { created: p.created, votingStart: p.start, votingEnd: p.end },
          quorum: p.quorum ?? null,
          votes: p.votes ?? null,
          scores: p.scores ?? null,
          scoresTotal: p.scores_total ?? null,
          choices: p.choices ?? null,
          lock: analyzeLock(p),
          quorumReachedTs: qReached,
          mathematicallyLockedTs: 'UNKNOWN', // requires eligible-power proof we do not have
          voteTimeline,
          voteTimelineComplete: timelineComplete,
          // KNOWLEDGE TIME: proposal existence knowable at creation; final
          // scores/lock analysis only at voting close; each vote at its own
          // public timestamp.
          provenance: {
            proposalExistence: { source: 'snapshot.org graphql', sourceTs: p.created, availableTs: p.created, retrievedTs: nowIso(), kind: 'historical', form: 'raw' },
            finalScores: { source: 'snapshot.org graphql', sourceTs: p.end, availableTs: p.end, retrievedTs: nowIso(), kind: 'historical', form: 'derived' },
            lockAnalysis: { source: 'derived from final tally (descriptive only)', sourceTs: p.end, availableTs: p.end, retrievedTs: nowIso(), kind: 'historical', form: 'derived' },
            voteTimeline: { source: voteTimeline === 'UNAVAILABLE' ? 'not retrieved' : 'snapshot.org graphql votes', sourceTs: 'per-vote created', availableTs: 'per-vote created', retrievedTs: nowIso(), kind: 'historical', form: 'raw' },
          },
        });
      }
      if (!proposals.length) gaps.push(`${coin}: space ${space} returned 0 proposals`);
    } catch (err) {
      gaps.push(`${coin}: snapshot fetch failed (${err.message})`);
    }
    await sleep(1500);
  }
  const unmapped = universeCoins.filter((c) => !SNAPSHOT_SPACES[c]);
  if (unmapped.length) gaps.push(`no verified snapshot space mapping: ${unmapped.join(', ')}`);
  gaps.push('Tally: UNAVAILABLE (requires API key; this project holds no keys)');
  if (timelinesUnavailable) gaps.push(`vote timelines unavailable for ${timelinesUnavailable} proposals (budget ${voteRequestBudget} requests or fetch failure)`);
  return { records, gaps, voteStats: { votesRetrieved, timelinesComplete, timelinesUnavailable, voteRequestsUsed } };
}

// Kraken public incident archive. firstPublicTs = the EARLIEST defensible
// public publication timestamp across created_at and every update — never
// array position (B-0B §14).
export function firstPublicTsOf(incident) {
  const candidates = [incident?.created_at, ...(incident?.incident_updates ?? []).map((u) => u?.created_at)]
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter((t) => Number.isFinite(t));
  if (!candidates.length) return null;
  return new Date(Math.min(...candidates)).toISOString();
}

// THE WALL APPLIES TO INCIDENTS TOO (B-0B.1 §8): incident FACTS (what was
// public, when) and incident OUTCOMES (what prices did afterward) are
// SEPARATE records in SEPARATE files, linked by incidentId. A point-in-time
// learner reading incidents.jsonl can never accidentally consume the future
// as contemporary evidence. Outcome horizons obey full-horizon coverage
// discipline (§1): a horizon the source does not fully cover is null.
export async function fetchIncidentHistory(stores60m) {
  const res = await fetch('https://status.kraken.com/api/v2/incidents.json', {
    signal: AbortSignal.timeout(25000),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`incidents HTTP ${res.status}`);
  const body = await res.json();
  const events = parseStatuspage('kraken', { incidents: body.incidents ?? [] }, nowIso());
  const incidents = [];
  const incidentOutcomes = [];
  for (const e of events) {
    const raw = (body.incidents ?? []).find((i) => i.id === e.sourceId);
    const firstPublicTs = firstPublicTsOf(raw) ?? e.announcedAt ?? null;
    incidents.push({
      ...e,
      incidentId: e.sourceId,
      firstPublicTs, // earliest defensible public knowledge time
      sourceTs: e.announcedAt ?? null,
      retrievedTs: nowIso(),
      provenance: { source: 'status.kraken.com incident archive', sourceTs: e.announcedAt ?? null, availableTs: firstPublicTs, retrievedTs: nowIso(), kind: 'historical', form: 'raw' },
    });
    const outcomes = {};
    for (const asset of e.assets) {
      const store = stores60m.get(asset);
      const t0 = firstPublicTs ? Date.parse(firstPublicTs) / 1000 : null;
      if (!store || !t0) {
        outcomes[asset] = { available: false, reason: t0 ? 'asset outside candle coverage' : 'no first-public ts' };
        continue;
      }
      const entry = store.atOrBefore(t0)?.[4];
      if (!entry) {
        outcomes[asset] = { available: false, reason: 'incident precedes candle coverage' };
        continue;
      }
      if (!store.coversHorizon(t0, 3600)) {
        outcomes[asset] = { available: false, reason: 'source coverage ends before the 1h horizon completes' };
        continue;
      }
      const fut1h = store.future(t0, 3600);
      const covers4h = store.coversHorizon(t0, 14400);
      const fut4h = covers4h ? store.future(t0, 14400) : [];
      outcomes[asset] = {
        available: true,
        ret1hPct: fut1h.length ? Number(((retBetween(fut1h.at(-1)[4], entry) ?? 0) * 100).toFixed(3)) : null,
        ret4hPct: covers4h && fut4h.length ? Number(((retBetween(fut4h.at(-1)[4], entry) ?? 0) * 100).toFixed(3)) : null,
        mfe1hPct: mfeMae(entry, fut1h).mfe,
        mae1hPct: mfeMae(entry, fut1h).mae,
      };
    }
    incidentOutcomes.push({
      incidentId: e.sourceId,
      firstPublicTs,
      outcomes,
      provenance: { source: 'labeler: kraken 60m candles after firstPublicTs (full-horizon gated)', sourceTs: firstPublicTs, availableTs: 'POST_HOC_LABEL_NEVER_REPLAY_VISIBLE', retrievedTs: nowIso(), kind: 'historical', form: 'derived' },
    });
  }
  return { incidents, incidentOutcomes };
}
