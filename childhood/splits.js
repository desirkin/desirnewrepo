// Event-aware DISCOVERY/EMBARGO/VALIDATION assignment (B-0A §3+§4).
// One event never straddles partitions, and a DISCOVERY event's entire
// labeling horizon must end before the nominal boundary — otherwise its
// outcome would be computed from Validation-period prices.
import { HORIZONS_MIN } from './labeler.js';

export const MAX_HORIZON_SEC = Math.max(...HORIZONS_MIN) * 60; // 4h embargo width

export function assignSplits(observations, nominalBoundary) {
  const events = new Map();
  for (const o of observations) {
    const e = events.get(o.eventId) ?? { min: Infinity, max: -Infinity };
    e.min = Math.min(e.min, o.ts);
    e.max = Math.max(e.max, o.ts);
    events.set(o.eventId, e);
  }
  const splitOf = new Map();
  for (const [id, e] of events) {
    if (e.max + MAX_HORIZON_SEC <= nominalBoundary) splitOf.set(id, 'DISCOVERY');
    else if (e.min >= nominalBoundary) splitOf.set(id, 'VALIDATION');
    else splitOf.set(id, 'EMBARGOED');
  }
  for (const o of observations) o.split = splitOf.get(o.eventId);
  return { uniqueEvents: events.size, splitOf };
}
