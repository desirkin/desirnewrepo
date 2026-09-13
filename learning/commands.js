// LEARN-1 — CLI commands (wired as `cobra learning <sub>` in bin/cobra.js). Read-only where possible; the campaign
// runner works only over local retained history (the promoted Childhood archive by default) and makes no network,
// order or LLM calls. Exit codes: 0 honest completion (shortage included), 1 refused/failed.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig, dataDir } from '../lib/config.js';
import { createLearningStore } from './store.js';
import { declareCampaign, runCampaignChunk, campaignStatus, pauseCampaign, resumeCampaign, preflightCampaign } from './campaign.js';
import { buildDailySummary } from './summary.js';
import { PROVIDER_DELAY_EVIDENCE } from './source-delay.js';
import { utcDateOf } from './contracts.js';

const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));

async function openArchive(dirOverride) {
  const config = loadConfig();
  const archiveDir = dirOverride ?? path.join(dataDir(config), 'childhood');
  if (!existsSync(archiveDir)) return { archive: null, archiveDir, reason: 'CHILDHOOD_ARCHIVE_ABSENT' };
  const { readLearningArchive } = await import('./labels.js');
  try { return { archive: readLearningArchive(archiveDir), archiveDir, reason: null }; }
  catch (err) { return { archive: null, archiveDir, reason: `ARCHIVE_UNREADABLE: ${err.message}` }; }
}

export async function runLearningCommand(sub, flag, rest) {
  const config = loadConfig();
  const store = createLearningStore({ dataDir: dataDir(config), log: console.log });
  const now = Date.now();
  switch (sub) {
    case 'status': {
      const status = store.readStatus();
      if (!status) { out('learning: no status file (service dark or never started). Enable with LEARNING_ENABLED=true under the data-only runtime (fly.js).'); process.exitCode = 1; return; }
      out(status); return;
    }
    case 'preflight': {
      const { archive, archiveDir, reason } = await openArchive(typeof flag('archive') === 'string' ? flag('archive') : undefined);
      if (!archive) { out({ ready: false, archiveDir, reason, note: 'a working API key is not proof of historical data; the campaign needs actual retained candle history' }); process.exitCode = 1; return; }
      const grid = Number(flag('grid-minutes') ?? 30);
      out({ ready: true, archiveDir, preflight: preflightCampaign({ archive, gridMinutes: grid }), sourceDelayEvidence: PROVIDER_DELAY_EVIDENCE }); return;
    }
    case 'campaign-declare': {
      const { archive, archiveDir, reason } = await openArchive(typeof flag('archive') === 'string' ? flag('archive') : undefined);
      if (!archive) { out({ declared: false, archiveDir, reason }); process.exitCode = 1; return; }
      const mode = typeof flag('mode') === 'string' ? flag('mode') : 'HISTORICAL_REPLAY';
      if (!['HISTORICAL_REPLAY', 'SYNTHETIC_STRESS'].includes(mode)) { out('learning campaign-declare: --mode must be HISTORICAL_REPLAY or SYNTHETIC_STRESS (prospective capture belongs to the continuous service)'); process.exitCode = 1; return; }
      const manifest = declareCampaign({
        store, createdTs: now, mode, datasetId: `childhood:${archive.census.identity.manifestSha256.slice(0, 16)}`,
        datasetIdentity: { kind: 'CHILDHOOD_ARCHIVE', dir: archiveDir, manifestSha256: archive.census.identity.manifestSha256, limitations: archive.limitations },
        terminalTarget: Number(flag('target') ?? 100_000), seed: String(flag('seed') ?? `seed-${now}`),
        gridMinutes: Number(flag('grid-minutes') ?? 30),
      });
      out({ declared: true, campaignId: manifest.campaignId, terminalTarget: manifest.terminalTarget }); return;
    }
    case 'campaign-run': {
      const id = flag('id'); if (typeof id !== 'string') { out('learning campaign-run --id <campaignId> [--max N] [--max-wall-ms M] [--archive DIR]'); process.exitCode = 1; return; }
      const { archive, reason } = await openArchive(typeof flag('archive') === 'string' ? flag('archive') : undefined);
      if (!archive) { out({ ran: false, reason }); process.exitCode = 1; return; }
      const started = Date.now();
      const r = runCampaignChunk({ store, campaignId: id, archive, nowTs: now, maxOpportunities: flag('max') ? Number(flag('max')) : null, maxWallMs: flag('max-wall-ms') ? Number(flag('max-wall-ms')) : null });
      const st = campaignStatus({ store, campaignId: id });
      const wallMs = Date.now() - started;
      out({
        ran: true, chunk: r.chunk, checkpoint: r.checkpoint, status: st,
        measuredThroughput: { opportunitiesThisRun: r.chunk.processed, wallMs, perMinute: wallMs > 0 ? Math.round((r.chunk.processed / wallMs) * 60_000) : null },
        remainingEligible: st ? Math.max(0, st.terminalTarget - st.primaryUnique) : null,
        estimateLaw: 'ESTIMATE_CONDITIONAL_ON_THIS_MEASURED_THROUGHPUT_ONLY',
      });
      return;
    }
    case 'campaign-status': {
      const id = flag('id');
      if (typeof id !== 'string') { out({ campaigns: store.listCampaigns() }); return; }
      const st = campaignStatus({ store, campaignId: id });
      if (!st) { out('unknown campaign'); process.exitCode = 1; return; }
      out(st); return;
    }
    case 'campaign-pause': { const id = flag('id'); out(pauseCampaign({ store, campaignId: String(id), nowTs: now })); return; }
    case 'campaign-resume': { const id = flag('id'); out(resumeCampaign({ store, campaignId: String(id), nowTs: now })); return; }
    case 'patterns': {
      const heads = [...store.patternHeads().values()];
      out(heads.map((p) => ({ patternId: p.patternId, state: p.state, scope: p.scope, raw: p.evidence.rawCount, groups: p.evidence.groupCount, favorable: p.evidence.favorable, adverse: p.evidence.adverse, censored: p.evidence.censored, estimate: p.estimate ? { mean: p.estimate.posteriorMean, lower95: p.estimate.lower95, upper95: p.estimate.upper95 } : null, contradictions: p.contradictions.length })));
      return;
    }
    case 'summary': {
      const date = typeof flag('date') === 'string' ? flag('date') : utcDateOf(now);
      const stored = store.readSummary(date);
      out(stored ?? buildDailySummary({ store, utcDate: date, nowTs: now })); return;
    }
    case 'kill': { store.writeKill({ state: 'KILLED', reason: 'CLI_KILL', ts: now }); out('learned influence KILLED — adapter answers baseline; collection and learning continue'); return; }
    case 'arm': { store.writeKill({ state: 'ARMED', reason: 'CLI_ARM', ts: now }); out('learned influence ARMED (activations still gate on their own state/expiry/applicability)'); return; }
    default: {
      out(`cobra learning <sub>
  status                                  service heartbeat + counters (read-only)
  preflight [--archive DIR] [--grid-minutes N]   inspect ACTUAL retained history for the replay campaign
  campaign-declare [--target N] [--seed S] [--grid-minutes N] [--archive DIR]
  campaign-run --id <campaignId> [--max N] [--max-wall-ms M] [--archive DIR]
  campaign-status [--id <campaignId>]     honest deduplicated counts (primary vs variants vs groups)
  campaign-pause --id / campaign-resume --id
  patterns                                provisional pattern memory heads
  summary [--date YYYY-MM-DD]             the daily research summary
  kill / arm                              the learned-influence kill switch (separate from collection)`);
      process.exitCode = 1;
    }
  }
}
