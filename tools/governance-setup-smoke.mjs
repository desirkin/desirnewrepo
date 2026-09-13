// One bounded host commissioning pass for the existing Snapshot governance path.
// It never starts PAPER, trading, or a continuous collector and uses a temporary
// data directory so normal runtime state is untouched.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startGovernance } from '../governance/collector.js';

const smokeDir = mkdtempSync(path.join(tmpdir(), 'serpent-governance-smoke-'));
const previousDataDir = process.env.COBRA_DATA_DIR;
process.env.COBRA_DATA_DIR = smokeDir;

const config = {
  governance: {
    enabled: true,
    snapshotEnabled: true,
    discoverySec: 60,
    refreshSec: 60,
    activeSnapshotSec: 60,
    timeoutMs: 15_000,
    requestsPerHour: 12,
    minSpacingMs: 1_100,
    backoffBaseSec: 30,
    backoffMaxSec: 1_800,
    backoff429Sec: 900,
    proposalPageSize: 5,
    maxProposalPagesPerCycle: 1,
    votePageSize: 25,
    maxVotePagesPerProposal: 1,
    maxMappedSymbols: 64,
    maxActiveProposals: 1,
    maxEventsPerPoll: 8,
    maxProposalTextBytes: 2_048,
    maxTitleBytes: 256,
  },
};

let runtime = null;
try {
  runtime = startGovernance({ config, intervalMs: 86_400_000, log: () => {} });
  if (!runtime) throw new Error('governance runtime did not compose');
  await runtime.pollOnce();
  runtime.stop();

  const statusPath = path.join(smokeDir, 'governance', 'status.json');
  const eventsPath = path.join(smokeDir, 'governance', 'events.jsonl');
  const status = JSON.parse(readFileSync(statusPath, 'utf8'));
  let events = [];
  try {
    events = readFileSync(eventsPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  console.log(JSON.stringify({
    ok: true,
    paperStarted: false,
    continuousPollingStarted: false,
    authority: 'NONE',
    mappedEntities: status.mappedEntities,
    snapshotSpaces: runtime.registry.snapshotSpaces,
    requests: status.requests,
    requestFailures: status.requestFailures,
    proposalsObserved: status.proposalsObserved,
    eventsEmitted: status.eventsEmitted,
    durableObservations: events.length,
    providers: status.providers,
    status: status.status,
    lastErrorTs: status.lastErrorTs,
    sample: events.slice(0, 2).map((event) => ({
      provider: event.provider,
      symbol: event.symbol,
      spaceId: event.spaceId,
      proposalId: event.proposalId,
      proposalState: event.proposalState,
      lifecycleTransition: event.lifecycleTransition,
      authority: event.authority,
    })),
  }, null, 2));
} finally {
  runtime?.stop();
  if (previousDataDir === undefined) delete process.env.COBRA_DATA_DIR;
  else process.env.COBRA_DATA_DIR = previousDataDir;
  rmSync(smokeDir, { recursive: true, force: true });
}
