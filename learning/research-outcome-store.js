// RESEARCH OUTCOME STORE (B-2, 2026-09-16). The durable head-selected attachment store for the 1h/4h/24h research
// horizons of every recorded PAPER decision. The decision-outcome record is written ONCE at 15-minute maturity (L-2),
// so its 1h/4h/24h columns are frozen NOT_YET_KNOWN there — the primary store hard-refuses re-append. This store holds
// the SEPARATE, later re-scoring: as each longer horizon elapses the research-maturation pass re-scores the columns
// from the fuller tape and appends an attachment carrying `supersedes` (the prior head's attachedTs). The snapshot is
// never rewritten; the latest attachment per decisionId is the head. Authority NONE: it records what the tape later
// showed and nothing reads it back into a decision. Lives beside the decision outcomes under data/learning/ so PERSIST-1
// backs it up. Mirrors decision-outcome-store.js (append-only JSONL, torn line skipped) and maturation.js (supersede
// head-selection) — no new idiom.
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { appendJsonl } from '../lib/jsonl.js';
import { isTs, isCoin, AUTHORITY, PURPOSE } from './contracts.js';
import { researchHorizonsError } from './decision-yardstick.js';

export const RESEARCH_OUTCOME_VERSION = 'research-outcome-1';
const MAX_STORE_BYTES = 256 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/;

// Validate one research-horizon attachment. Reuses the yardstick's own research-column law (finite log return ONLY when
// KNOWN; NaN in memory, null on re-read; never a fabricated zero) so the two can never drift.
export function researchOutcomeError(a) {
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return 'record must be an object';
  if (a.recordVersion !== RESEARCH_OUTCOME_VERSION) return 'unsupported research outcome version';
  if (typeof a.decisionId !== 'string' || !ID_RE.test(a.decisionId)) return 'decisionId malformed';
  if (!isCoin(a.assetId)) return 'assetId is not a canonical coin';
  if (!isTs(a.decisionKnownAtTs) || !isTs(a.attachedTs) || !isTs(a.asOfTs)) return 'clocks malformed';
  if (a.supersedes !== null && !isTs(a.supersedes)) return 'supersedes malformed';
  const rhe = researchHorizonsError(a.researchHorizons); if (rhe) return `research ${rhe}`;
  if (a.authority !== AUTHORITY || a.purpose !== PURPOSE) return 'authority must be NONE / RESEARCH_ONLY';
  return null;
}

// Open the durable store. The head per decisionId is the attachment with the greatest attachedTs, rebuilt from the file
// on open — so a restart re-selects the same head and the pass re-matures safely. A torn or foreign line is skipped and
// counted, never trusted. Append never refuses a valid attachment (the maturation sweep decides what is new); this
// store only validates, persists, and advances the head.
export function openResearchOutcomeStore({ dir, log = () => {}, maxBytes = MAX_STORE_BYTES } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('openResearchOutcomeStore: dir required');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'research-outcomes.jsonl');
  const heads = new Map(); // decisionId -> head attachment (max attachedTs)
  let skipped = 0;
  const consider = (rec) => { const prev = heads.get(rec.decisionId); if (!prev || rec.attachedTs >= prev.attachedTs) heads.set(rec.decisionId, rec); };
  if (existsSync(file)) {
    if (statSync(file).size > maxBytes) throw new Error('research outcome store exceeds the read bound');
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim(); if (!t) continue;
      let rec; try { rec = JSON.parse(t); } catch { skipped += 1; continue; }
      if (researchOutcomeError(rec)) { skipped += 1; continue; }
      consider(rec);
    }
  }
  if (skipped) log(`research outcome store: ${skipped} unreadable line(s) skipped on open`);

  return Object.freeze({
    version: RESEARCH_OUTCOME_VERSION,
    has: (decisionId) => heads.has(decisionId),
    count: () => heads.size,
    latestAttachments: () => new Map(heads), // decisionId -> head; a detached copy, never the live map
    append: (attach) => {
      const e = researchOutcomeError(attach); if (e) throw new Error(`research outcome store: refusing an invalid record: ${e}`);
      appendJsonl(file, attach);
      consider(attach);
      return true;
    },
    status: () => Object.freeze({ version: RESEARCH_OUTCOME_VERSION, decisions: heads.size, skippedOnOpen: skipped }),
  });
}
