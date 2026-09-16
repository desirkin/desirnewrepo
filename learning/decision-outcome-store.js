// DECISION OUTCOME STORE (Ticket 3 step 2, 2026-09-15). A durable, append-only, idempotent store for the matured
// bite/continuation yardstick outcome of every PAPER decision. It lives under data/learning/ (so PERSIST-1 backs it up)
// and holds one record per decisionId plus a read cursor into the execution journal. Authority NONE: it records what
// happened, and nothing reads it back into a decision. The recorder is the sole writer.
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { isTs, isCoin, isCount } from './contracts.js';
import { decisionYardstickError } from './decision-yardstick.js';

export const DECISION_OUTCOME_VERSION = 'decision-outcome-1';
export const DECISION_STATES = Object.freeze(['NO_TRADE', 'NEEDS_DATA', 'WATCH_CANDIDATE', 'ENTRY_PROPOSED', 'ENTRY_RESERVED', 'ENTRY_REFUSED', 'EXPIRED']);
const MAX_STORE_BYTES = 256 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/;

export function decisionOutcomeError(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return 'record must be an object';
  if (record.recordVersion !== DECISION_OUTCOME_VERSION) return 'unsupported outcome record version';
  if (typeof record.decisionId !== 'string' || !ID_RE.test(record.decisionId)) return 'decisionId malformed';
  if (!isCoin(record.assetId)) return 'assetId is not a canonical coin';
  if (!isTs(record.decisionKnownAtTs) || !isTs(record.recordedTs)) return 'clocks malformed';
  if (!isCount(record.seq) || record.seq < 1) return 'journal seq malformed';
  if (!DECISION_STATES.includes(record.decisionState)) return 'decision state outside the closed set';
  const ye = decisionYardstickError(record.yardstick); if (ye) return `yardstick ${ye}`;
  if (record.yardstick.canonicalCoin !== record.assetId || record.yardstick.decisionKnownAtTs !== record.decisionKnownAtTs) return 'yardstick identity disagrees with the record';
  return null;
}

// Open the durable store. Idempotent by decisionId: the id index is rebuilt from the file on open, so a restart never
// double-records and the recorder can re-mature safely. A torn or foreign line is skipped and counted, never trusted.
export function openDecisionOutcomeStore({ dir, log = () => {}, maxBytes = MAX_STORE_BYTES } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('openDecisionOutcomeStore: dir required');
  mkdirSync(dir, { recursive: true });
  const outcomesFile = path.join(dir, 'decision-outcomes.jsonl');
  const cursorFile = path.join(dir, 'cursor.json');
  const ids = new Set();
  // B-2: a minimal in-memory projection of every recorded decision — its id, coin and decision clock — so the research
  // maturation pass can revisit older decisions to fill the 1h/4h/24h research horizons WITHOUT re-reading the whole
  // JSONL each tick. One tiny frozen row per decision; grows exactly with `ids`, bounded by the same file read bound.
  const decisions = [];
  const project = (rec) => Object.freeze({ decisionId: rec.decisionId, assetId: rec.assetId, decisionKnownAtTs: rec.decisionKnownAtTs });
  let skipped = 0;
  if (existsSync(outcomesFile)) {
    if (statSync(outcomesFile).size > maxBytes) throw new Error('decision outcome store exceeds the read bound');
    for (const line of readFileSync(outcomesFile, 'utf8').split('\n')) {
      const t = line.trim(); if (!t) continue;
      let rec; try { rec = JSON.parse(t); } catch { skipped += 1; continue; }
      if (decisionOutcomeError(rec)) { skipped += 1; continue; }
      if (!ids.has(rec.decisionId)) { ids.add(rec.decisionId); decisions.push(project(rec)); }
    }
  }
  let cursor = 0;
  if (existsSync(cursorFile)) { try { const c = JSON.parse(readFileSync(cursorFile, 'utf8')); if (isCount(c?.seq)) cursor = c.seq; } catch { /* a torn cursor restarts from 0; re-maturation is idempotent */ } }
  if (skipped) log(`decision outcome store: ${skipped} unreadable line(s) skipped on open`);

  return Object.freeze({
    version: DECISION_OUTCOME_VERSION,
    has: (decisionId) => ids.has(decisionId),
    count: () => ids.size,
    // B-2: the recorded decisions as { decisionId, assetId, decisionKnownAtTs } — the subject set the research
    // maturation pass sweeps to fill the 1h/4h/24h horizons. Read-only; a detached snapshot, never the live array.
    records: () => decisions.slice(),
    cursor: () => cursor,
    setCursor: (seq) => { if (!isCount(seq) || seq < cursor) return; cursor = seq; atomicWriteJson(cursorFile, { version: DECISION_OUTCOME_VERSION, seq, ts: Date.now() }, { sync: true }); },
    append: (record) => {
      const e = decisionOutcomeError(record); if (e) throw new Error(`decision outcome store: refusing an invalid record: ${e}`);
      if (ids.has(record.decisionId)) return false; // idempotent
      appendJsonl(outcomesFile, record);
      ids.add(record.decisionId);
      decisions.push(project(record));
      return true;
    },
    status: () => Object.freeze({ version: DECISION_OUTCOME_VERSION, recorded: ids.size, cursor, skippedOnOpen: skipped }),
  });
}
