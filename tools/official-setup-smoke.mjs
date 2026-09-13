#!/usr/bin/env node
// Bounded, data-only verification for the existing RUMOR2 official-source
// path. It uses the durable checkpoint/journal owner, performs one explicit
// tick, and keeps every social ear, PAPER, Judge, Watch, and execution off.
import { startPersistence } from '../persistence/runtime.js';
import { rumor2CheckpointStore } from '../persistence/rumor2-checkpoint.js';
import { rumor2JournalStore } from '../persistence/rumor2-journal.js';
import { startRumor2 } from '../rumor2/collector.js';

const VERIFIED = Object.freeze(['KRAKEN_OFFICIAL', 'SEC_OFFICIAL', 'CFTC_OFFICIAL', 'OFAC_OFFICIAL']);
const log = (message) => process.stderr.write(`${String(message).slice(0, 300)}\n`);

let persistence = null;
let rumor = null;
try {
  persistence = await startPersistence({ log });
  const health = persistence.health();
  if (!health.databaseConfigured || !health.restored) {
    throw new Error(`durable journal unavailable (${health.failureCategory ?? health.status})`);
  }

  rumor = startRumor2({
    enabled: true,
    intervalMs: 3_600_000,
    checkpointStore: rumor2CheckpointStore(),
    journal: rumor2JournalStore(),
    allowLocalJournal: false,
    edgarEnabled: false,
    ofacEnabled: true,
    socialBlueskyEnabled: false,
    socialXEnabled: false,
    socialFarcasterEnabled: false,
    socialCurrentEnabled: false,
    researchStrainer: null,
    log,
  });

  await rumor.tickOnce();
  const status = rumor.status();
  const providers = Object.fromEntries(
    Object.entries(status.providers).map(([id, source]) => [id, {
      selected: VERIFIED.includes(id),
      enabled: source.enabled,
      gateDetail: source.gateDetail,
      coverage: source.coverage,
      lastHttpStatus: source.lastHttpStatus,
      itemsObserved: source.itemsObserved,
      newItems: source.newItems,
      duplicates: source.duplicates,
      withheldItems: source.withheldItems,
      appendFailures: source.appendFailures,
    }]),
  );
  process.stdout.write(`${JSON.stringify({
    ok: VERIFIED.every((id) => providers[id]?.coverage?.state === 'OBSERVED'),
    command: 'official-setup-smoke',
    paperStarted: false,
    continuousPollingStarted: false,
    authority: 'NONE',
    durabilityMode: status.durabilityMode,
    lifecycle: status.lifecycle,
    lastSettledEventSeq: status.lastSettledEventSeq,
    providers,
  }, null, 2)}\n`);
} finally {
  if (rumor) await rumor.stop();
  if (persistence) await persistence.stop();
}
