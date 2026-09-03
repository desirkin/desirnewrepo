// Deep memory — rare events, as far back as reliably available.
// Governance via Snapshot's public GraphQL hub (no keys); Tally requires an
// API key this project does not hold -> UNAVAILABLE, recorded. Exchange
// incident history from Kraken's public status archive.
import { nowIso } from '../lib/time.js';
import { parseStatuspage } from '../gateway/parse.js';
import { mfeMae, retBetween } from './store.js';

const SNAPSHOT_HUB = 'https://hub.snapshot.org/graphql';

// Curated token -> Snapshot space map for universe-relevant tokens. Only
// mappings we attempt are listed; failures and unmapped tokens are gaps.
export const SNAPSHOT_SPACES = {
  UNI: 'uniswapgovernance.eth',
  CRV: 'curve.eth',
  AAVE: 'aave.eth',
  ARB: 'arbitrumfoundation.eth',
  OP: 'opcollective.eth',
};

export async function fetchGovernance(universeCoins) {
  const spaces = universeCoins.filter((c) => SNAPSHOT_SPACES[c]).map((c) => ({ coin: c, space: SNAPSHOT_SPACES[c] }));
  const records = [];
  const gaps = [];
  for (const { coin, space } of spaces) {
    try {
      const query = `{ proposals(first: 100, where: { space: "${space}" }, orderBy: "created", orderDirection: desc) {
        id title state created start end quorum scores scores_total choices votes } }`;
      const res = await fetch(SNAPSHOT_HUB, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const proposals = body.data?.proposals ?? [];
      for (const p of proposals) {
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
          provenance: { source: 'snapshot.org graphql', retrievedTs: nowIso(), kind: 'historical', form: 'raw' },
        });
      }
      if (!proposals.length) gaps.push(`${coin}: space ${space} returned 0 proposals`);
    } catch (err) {
      gaps.push(`${coin}: snapshot fetch failed (${err.message})`);
    }
    await new Promise((r) => setTimeout(r, 1500)); // politeness between spaces
  }
  const unmapped = universeCoins.filter((c) => !SNAPSHOT_SPACES[c]);
  if (unmapped.length) gaps.push(`no verified snapshot space mapping: ${unmapped.join(', ')}`);
  gaps.push('Tally: UNAVAILABLE (requires API key; this project holds no keys)');
  return { records, gaps };
}

// Lock analysis under the charter: MATHEMATICALLY_LOCKED demands knowing the
// remaining eligible voting power, which Snapshot does not expose. Without
// that basis the strongest honest claim is STATISTICALLY_NEAR_CERTAIN on a
// closed proposal with a decisive margin; LOCK_TIME is UNKNOWN everywhere
// the vote-by-vote timeline was not reconstructed.
export function analyzeLock(p) {
  const scores = p.scores ?? [];
  if (p.state !== 'closed' || scores.length < 2 || !p.scores_total) {
    return { status: 'UNKNOWN', lockTime: 'UNKNOWN', basis: 'proposal open or score data insufficient' };
  }
  const sorted = [...scores].sort((a, b) => b - a);
  const margin = sorted[0] - sorted[1];
  const quorumMet = p.quorum ? p.scores_total >= p.quorum : null;
  if (margin / p.scores_total > 0.2 && quorumMet !== false) {
    return {
      status: 'STATISTICALLY_NEAR_CERTAIN',
      lockTime: 'UNKNOWN',
      basis: `margin ${((margin / p.scores_total) * 100).toFixed(1)}% of cast power; remaining ELIGIBLE power unknown (snapshot does not expose it) so MATHEMATICALLY_LOCKED cannot be honestly claimed; vote timeline not reconstructed`,
    };
  }
  return { status: 'UNKNOWN', lockTime: 'UNKNOWN', basis: 'margin not decisive against cast power, eligible power unknown' };
}

// Kraken public incident archive, parsed with the same gateway parser the
// live collector uses, then labeled against our own candle memory where
// affected assets overlap coverage.
export async function fetchIncidentHistory(stores60m) {
  const res = await fetch('https://status.kraken.com/api/v2/incidents.json', {
    signal: AbortSignal.timeout(25000),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`incidents HTTP ${res.status}`);
  const body = await res.json();
  const events = parseStatuspage('kraken', { incidents: body.incidents ?? [] }, nowIso());
  return events.map((e) => {
    const outcomes = {};
    for (const asset of e.assets) {
      const store = stores60m.get(asset);
      const t0 = e.announcedAt ? Date.parse(e.announcedAt) / 1000 : null;
      if (!store || !t0) {
        outcomes[asset] = { available: false, reason: store ? 'no announce ts' : 'asset outside candle coverage' };
        continue;
      }
      const entry = store.atOrBefore(t0)?.[4];
      const fut1h = store.future(t0, 3600);
      const fut4h = store.future(t0, 14400);
      if (!entry || !fut1h.length) {
        outcomes[asset] = { available: false, reason: 'incident outside 30d candle window' };
        continue;
      }
      outcomes[asset] = {
        available: true,
        ret1hPct: Number(((retBetween(fut1h.at(-1)[4], entry) ?? 0) * 100).toFixed(3)),
        ret4hPct: fut4h.length ? Number(((retBetween(fut4h.at(-1)[4], entry) ?? 0) * 100).toFixed(3)) : null,
        mfe1hPct: mfeMae(entry, fut1h).mfe,
        mae1hPct: mfeMae(entry, fut1h).mae,
      };
    }
    return { ...e, historicalOutcomes: outcomes, provenance: { source: 'status.kraken.com incident archive', retrievedTs: nowIso(), kind: 'historical', form: 'raw' } };
  });
}
