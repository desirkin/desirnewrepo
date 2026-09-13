// LEARN-1 — dependence grouping. Related is not independent: one asset's adjacent minutes share one episode group;
// one market-wide shock day correlates every asset's observations inside it. Raw counts and effective group counts
// are both first-class facts; nothing here claims exact independence — the label on the output says APPROXIMATE.
//
// Group law (learning-group-law-1, deterministic, future-blind):
//   episode group  = (canonicalCoin, floor(decisionTs / EPISODE_WINDOW_MS))   — adjacent observations of one asset
//   shock group    = utcDate when the day is marked COMMON_SHOCK (a supplied set of dates; callers derive it from
//                    contemporaneous breadth evidence, never from the outcomes being grouped)
// Two observations sharing EITHER key are dependent (union-find over both keys).
import { utcDateOf, deepFreeze } from './contracts.js';

export const GROUP_LAW_VERSION = 'learning-group-law-1';
export const EPISODE_WINDOW_MS = 4 * 3_600_000; // one asset within 4h = one episode group (matches the max label horizon)

export function groupKeysOf({ canonicalCoin, decisionTs }, { commonShockDates = new Set() } = {}) {
  const keys = [`EP:${canonicalCoin}:${Math.floor(decisionTs / EPISODE_WINDOW_MS)}`];
  const date = utcDateOf(decisionTs);
  if (commonShockDates.has(date)) keys.push(`SHOCK:${date}`);
  return keys;
}

// union-find over observations -> [{ groupId, members: [indexes], assets:Set, dates:Set }]
export function assignGroups(observations, { commonShockDates = new Set() } = {}) {
  const parent = new Map();
  const find = (k) => { let r = k; while (parent.get(r) !== r) r = parent.get(r); let c = k; while (parent.get(c) !== c) { const n = parent.get(c); parent.set(c, r); c = n; } return r; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const keyOwner = new Map();
  observations.forEach((o, i) => {
    const self = `OBS:${i}`; parent.set(self, self);
    for (const k of groupKeysOf(o, { commonShockDates })) {
      if (!parent.has(k)) parent.set(k, k);
      union(self, k);
    }
    keyOwner.set(self, i);
  });
  const groups = new Map();
  observations.forEach((o, i) => {
    const root = find(`OBS:${i}`);
    if (!groups.has(root)) groups.set(root, { members: [], assets: new Set(), dates: new Set() });
    const g = groups.get(root);
    g.members.push(i); g.assets.add(o.canonicalCoin); g.dates.add(utcDateOf(o.decisionTs));
  });
  const list = [...groups.values()].map((g, idx) => ({ groupId: `g${idx}`, members: g.members, assets: [...g.assets].sort(), dates: [...g.dates].sort() }));
  return deepFreeze({
    law: GROUP_LAW_VERSION, independenceClaim: 'APPROXIMATE_GROUPING_NOT_EXACT_INDEPENDENCE',
    rawCount: observations.length, groupCount: list.length, groups: list,
    distinctAssets: new Set(observations.map((o) => o.canonicalCoin)).size,
    distinctUtcDates: new Set(observations.map((o) => utcDateOf(o.decisionTs))).size,
  });
}
