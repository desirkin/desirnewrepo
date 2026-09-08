// MARKET LAB — bounded hot state (§5). Everything in memory is capped by count AND bytes; eviction is recorded as a
// coverage gap with a measured dropped count, never silent. Trades per hot symbol, book samples (241 samples for the
// latest two minutes at most once per 500 ms, plus one endpoint sample per closed minute for 180 minutes with actual
// sample age), bars per interval, and bounded side maps (dedup ids, in-flight requests, caches, error samples).
// Same recorded prefix + policy => same resource / completeness state (deterministic eviction order).
import { deepFreeze, fail, isTs } from './contracts.js';
import { RESOURCE_DEFAULTS } from './policy.js';
import { minuteFloor, MINUTE_MS } from './time.js';

const approxBytes = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');
export function createHotState({ limits = RESOURCE_DEFAULTS, log = () => {} } = {}) {
  const subjects = new Map(); // subjectId -> { subject, trades: [], tradeBytes, bookSamples: [], minuteEndpoints: [], bars: Map(intervalMs -> []), dedup: Set, lastBookSampleTs, admittedTs, evictions: {...} }
  let totalBytes = 0; const evictions = { trades: 0, bookSamples: 0, bars: 0, subjects: 0, bytesPressure: 0 };
  const admissionLog = []; const MAX_LOG = 512;
  const logAdmission = (e) => { admissionLog.push(e); if (admissionLog.length > MAX_LOG) admissionLog.shift(); };
  function admit(subjectId, subject, ts) {
    if (subjects.has(subjectId)) return subjects.get(subjectId);
    if (subjects.size >= limits.hotSubjects) { // evict the least recently touched subject deterministically (oldest lastTouch, then id)
      const victim = [...subjects.entries()].sort((a, b) => (a[1].lastTouchTs - b[1].lastTouchTs) || (a[0] < b[0] ? -1 : 1))[0];
      release(victim[0], ts, 'HOT_SET_CAP');
    }
    const s = { subject, trades: [], tradeBytes: 0, bookSamples: [], minuteEndpoints: [], bars: new Map(), barBytes: 0, dedup: new Set(), dedupOrder: [], lastBookSampleTs: 0, admittedTs: ts, lastTouchTs: ts, dropped: { trades: 0, bookSamples: 0, bars: 0, duplicates: 0 } };
    subjects.set(subjectId, s); logAdmission({ ts, subjectId, action: 'ADMITTED' });
    return s;
  }
  function release(subjectId, ts, reason) { const s = subjects.get(subjectId); if (!s) return; totalBytes -= s.tradeBytes + s.barBytes; subjects.delete(subjectId); evictions.subjects += 1; logAdmission({ ts, subjectId, action: 'EVICTED', reason, retained: { trades: s.trades.length, bookSamples: s.bookSamples.length } }); }
  const pressure = () => totalBytes > limits.hotStateBytes;
  function shedBytes(ts) { // deterministic: drop oldest trades across subjects (largest tradeBytes first) until under the ceiling
    let guard = 0;
    while (pressure() && guard < 100_000) { guard += 1; const s = [...subjects.values()].filter((x) => x.trades.length).sort((a, b) => (b.tradeBytes - a.tradeBytes) || (a.admittedTs - b.admittedTs))[0]; if (!s) break; const t = s.trades.shift(); const b = approxBytes(t); s.tradeBytes -= b; totalBytes -= b; s.dropped.trades += 1; evictions.bytesPressure += 1; s.evictedTradesUntilTs = t.sourceEventTs ?? t.receivedTs; }
  }
  // ---- trades (event-time ordered append; dedup by sourceKey) ----
  function addTrade(subjectId, subject, o) {
    const s = admit(subjectId, subject, o.receivedTs); s.lastTouchTs = o.receivedTs;
    if (o.sourceKey !== null) { if (s.dedup.has(o.sourceKey)) { s.dropped.duplicates += 1; return { admitted: false, reason: 'DUPLICATE' }; } s.dedup.add(o.sourceKey); s.dedupOrder.push(o.sourceKey); if (s.dedupOrder.length > limits.tradesPerHotSymbol) s.dedup.delete(s.dedupOrder.shift()); }
    const b = approxBytes(o); s.trades.push(o); s.tradeBytes += b; totalBytes += b;
    if (s.trades.length > limits.tradesPerHotSymbol) { const t = s.trades.shift(); const tb = approxBytes(t); s.tradeBytes -= tb; totalBytes -= tb; s.dropped.trades += 1; evictions.trades += 1; s.evictedTradesUntilTs = t.sourceEventTs ?? t.receivedTs; }
    if (pressure()) shedBytes(o.receivedTs);
    return { admitted: true };
  }
  // ---- book samples: at most one per 500 ms; 241 rolling + closed-minute endpoints for 180 minutes ----
  function shouldSampleBook(subjectId, receivedTs) { const s = subjects.get(subjectId); return !s || receivedTs - s.lastBookSampleTs >= limits.bookSampleMinIntervalMs; }
  function addBookSample(subjectId, subject, sample) { // sample: { receivedTs, bids, asks, synced, checksumOk, epochId, observationId }
    const s = admit(subjectId, subject, sample.receivedTs); s.lastTouchTs = sample.receivedTs;
    if (sample.receivedTs - s.lastBookSampleTs < limits.bookSampleMinIntervalMs) { s.dropped.bookSamples += 1; return { admitted: false, reason: 'RATE' }; }
    s.lastBookSampleTs = sample.receivedTs;
    s.bookSamples.push(sample); if (s.bookSamples.length > limits.bookSamplesTwoMinutes) { s.bookSamples.shift(); evictions.bookSamples += 1; }
    // closed-minute endpoint: when a sample is the FIRST inside a new minute, the previous sample is the latest sample at or
    // before that boundary (a sample landing exactly on the boundary is its own endpoint); never a sample from inside the minute
    const n = s.bookSamples.length; const prev = n >= 2 ? s.bookSamples[n - 2] : null;
    const boundary = minuteFloor(sample.receivedTs); const onBoundary = sample.receivedTs === boundary;
    const endpoint = onBoundary ? sample : prev && minuteFloor(prev.receivedTs) < boundary ? prev : null;
    if (endpoint) { const last = s.minuteEndpoints[s.minuteEndpoints.length - 1]; if (!last || last.minuteTs < boundary) { s.minuteEndpoints.push({ minuteTs: boundary, sample: endpoint, ageMs: boundary - endpoint.receivedTs }); if (s.minuteEndpoints.length > limits.bookMinuteEndpoints) s.minuteEndpoints.shift(); } }
    return { admitted: true };
  }
  // ---- bars per interval ----
  function addBar(subjectId, subject, o) {
    const s = admit(subjectId, subject, o.receivedTs); s.lastTouchTs = o.receivedTs; const key = o.payload.intervalMs;
    if (!s.bars.has(key)) s.bars.set(key, []); const list = s.bars.get(key);
    const idx = list.findIndex((x) => x.periodStartTs === o.periodStartTs);
    const b = approxBytes(o);
    if (idx >= 0) { if (list[idx].payload.closed) { s.dropped.duplicates += 1; return { admitted: false, reason: 'CLOSED_BAR_IMMUTABLE' }; } s.barBytes -= approxBytes(list[idx]); totalBytes -= approxBytes(list[idx]); list[idx] = o; s.barBytes += b; totalBytes += b; return { admitted: true, replacedProvisional: true }; }
    list.push(o); list.sort((x, y) => x.periodStartTs - y.periodStartTs); s.barBytes += b; totalBytes += b;
    if (list.length > limits.barsPerInterval) { const ev = list.shift(); s.barBytes -= approxBytes(ev); totalBytes -= approxBytes(ev); s.dropped.bars += 1; evictions.bars += 1; s.evictedBarsUntilTs = ev.periodEndTs; }
    if (pressure()) shedBytes(o.receivedTs);
    return { admitted: true };
  }
  // ---- views (never the live arrays) ----
  const view = (subjectId) => { const s = subjects.get(subjectId); if (!s) return null; return { subject: s.subject, trades: s.trades.slice(), bookSamples: s.bookSamples.slice(), minuteEndpoints: s.minuteEndpoints.slice(), bars: Object.fromEntries([...s.bars.entries()].map(([k, v]) => [k, v.slice()])), dropped: { ...s.dropped }, evictedTradesUntilTs: s.evictedTradesUntilTs ?? null, evictedBarsUntilTs: s.evictedBarsUntilTs ?? null, admittedTs: s.admittedTs, lastTouchTs: s.lastTouchTs }; };
  const status = () => deepFreeze({ subjects: subjects.size, hotSubjectsCap: limits.hotSubjects, totalBytes, byteCeiling: limits.hotStateBytes, evictions: { ...evictions }, perSubject: Object.fromEntries([...subjects.entries()].map(([id, s]) => [id, { trades: s.trades.length, tradeBytes: s.tradeBytes, bookSamples: s.bookSamples.length, minuteEndpoints: s.minuteEndpoints.length, bars: Object.fromEntries([...s.bars.entries()].map(([k, v]) => [k, v.length])), dropped: { ...s.dropped } }])), admissionLog: admissionLog.slice(-64) });
  return { addTrade, addBookSample, shouldSampleBook, addBar, view, release, status, has: (id) => subjects.has(id), ids: () => [...subjects.keys()].sort() };
}

// ---- bounded intake queue (items + bytes, whichever binds first) ----
export function createIntakeQueue({ limits = RESOURCE_DEFAULTS } = {}) {
  const q = []; let bytes = 0; let dropped = 0; let droppedBytes = 0;
  return {
    push(item) { const b = approxBytes(item); if (q.length >= limits.intakeQueueItems || bytes + b > limits.intakeQueueBytes) { dropped += 1; droppedBytes += b; return false; } q.push({ item, b }); bytes += b; return true; },
    drain(max = Infinity) { const out = []; while (q.length && out.length < max) { const { item, b } = q.shift(); bytes -= b; out.push(item); } return out; },
    status: () => ({ items: q.length, bytes, dropped, droppedBytes, itemCap: limits.intakeQueueItems, byteCap: limits.intakeQueueBytes }),
    takeDropped() { const d = dropped; dropped = 0; droppedBytes = 0; return d; },
  };
}
export { isTs, fail };
