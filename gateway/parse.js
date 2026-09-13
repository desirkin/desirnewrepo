// Gateway parsers — pure functions over official status payloads. No network.
// Anything we cannot parse with confidence becomes UNPARSED with the raw text
// archived; guessed structure is worse than admitted ignorance.

export const DOOR = Object.freeze({
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  DELAYED: 'DELAYED',
  DEGRADED: 'DEGRADED',
  MAINTENANCE: 'MAINTENANCE',
  UNKNOWN: 'UNKNOWN',
});

export const STAGES = Object.freeze([
  'investigating',
  'identified',
  'monitoring',
  'resolved',
  'scheduled',
  'in_progress',
  'verifying',
  'completed',
]);

// "Bitcoin (BTC) - Opt-in Rewards" -> BTC ; "Monad (MON) Funding Delays" -> MON
const SYMBOL_RE = /\(([A-Z0-9]{1,10})\)/g;
const NETWORK_RE =
  /\b(Ethereum|Bitcoin Network|Solana|BNB Chain|Base|Arbitrum(?: Nova| One)?|Optimism|Polygon|Avalanche|Tron|Core DAO|Cardano|Polkadot|Cosmos|Near|Sui|Aptos|Lightning)\b/gi;

// Bare-ticker fallback for sources that don't parenthesize (OKX titles):
// conservative — uppercase tokens only, stoplisted, used only when no
// parenthesized symbol exists in the text.
const BARE_TICKER_RE = /\b[A-Z][A-Z0-9]{1,6}\b/g;
const TICKER_STOPLIST = new Set([
  'OKX', 'API', 'REST', 'WS', 'FIX', 'UTC', 'GMT', 'CET', 'USD', 'EUR', 'GBP',
  'P2P', 'OTC', 'RFQ', 'ETF', 'II', 'III', 'IV', 'AM', 'PM', 'FAQ', 'UI', 'V5',
]);

export function extractAssets(text) {
  const paren = [...new Set([...(text ?? '').matchAll(SYMBOL_RE)].map((m) => m[1]))];
  if (paren.length) return paren;
  return [...new Set([...(text ?? '').matchAll(BARE_TICKER_RE)].map((m) => m[0]))].filter(
    (t) => !TICKER_STOPLIST.has(t)
  );
}

export function extractNetworks(text) {
  return [...new Set([...(text ?? '').matchAll(NETWORK_RE)].map((m) => m[1]))];
}

export function extractFunctions(text) {
  const t = (text ?? '').toLowerCase();
  const fns = new Set();
  if (/deposit|receive/.test(t)) fns.add('deposit');
  if (/withdraw|send/.test(t)) fns.add('withdrawal');
  if (/funding|sends\/receives|paused sends/.test(t)) {
    fns.add('deposit');
    fns.add('withdrawal');
  }
  if (/trading|order|matching engine|markets?/.test(t)) fns.add('trading');
  return [...fns];
}

function doorForIncident(stage, title, scheduled) {
  if (scheduled) return stage === 'completed' ? DOOR.OPEN : DOOR.MAINTENANCE;
  if (stage === 'resolved') return DOOR.OPEN;
  const t = (title ?? '').toLowerCase();
  if (/delay/.test(t)) return DOOR.DELAYED;
  if (/paused|halted|suspended|disabled|discontinued/.test(t)) return DOOR.CLOSED;
  return DOOR.DEGRADED;
}

// SURPRISE_SCORE: scheduled work surprises no one; the score is for sudden
// friction, scaled by the venue's own impact rating.
export function surpriseScore({ scheduled, impact }) {
  if (scheduled) return 0;
  return { none: 1, minor: 1, major: 2, critical: 3 }[impact] ?? 1;
}

// Normalize one Statuspage summary (Kraken/Coinbase both use it) into events.
export function parseStatuspage(venue, summary, observedAt) {
  const events = [];
  const push = (raw, { scheduled }) => {
    const text = `${raw.name} ${(raw.incident_updates ?? [])
      .map((u) => u.body)
      .join(' ')} ${(raw.components ?? []).map((c) => c.name).join(' ')}`;
    const assets = extractAssets(text);
    const networks = extractNetworks(text);
    const functions = extractFunctions(text);
    const stage = STAGES.includes(raw.status) ? raw.status : null;
    // Confident = we know the stage AND the scope: named assets, or a
    // scheduled event whose functions/networks parsed (venue-declared plan).
    const confident =
      stage !== null && (assets.length > 0 || (scheduled && (functions.length > 0 || networks.length > 0)));
    events.push({
      venue,
      sourceId: raw.id,
      title: raw.name,
      category: confident ? 'INCIDENT' : 'UNPARSED',
      assets,
      networks,
      functions: functions.length ? functions : confident ? ['unspecified'] : [],
      stage: stage ?? 'unknown',
      scheduled,
      impact: raw.impact ?? (scheduled ? 'maintenance' : 'unknown'),
      door: confident ? doorForIncident(stage, raw.name, scheduled) : DOOR.UNKNOWN,
      surpriseScore: surpriseScore({ scheduled, impact: raw.impact }),
      announcedAt: raw.created_at ?? raw.scheduled_for ?? null,
      stageTimestamps: {
        created: raw.created_at ?? null,
        monitoring: raw.monitoring_at ?? null,
        resolved: raw.resolved_at ?? null,
        scheduledFor: raw.scheduled_for ?? null,
        scheduledUntil: raw.scheduled_until ?? null,
      },
      observedAt,
      raw: confident ? undefined : { name: raw.name, status: raw.status, updates: (raw.incident_updates ?? []).map((u) => u.body) },
    });
  };
  for (const inc of summary.incidents ?? []) push(inc, { scheduled: false });
  for (const m of summary.scheduled_maintenances ?? []) push(m, { scheduled: true });
  return events;
}

// Kraken's own SystemStatus API: overall venue door + upcoming maintenance.
export function parseKrakenSystem(body, observedAt) {
  const r = body?.result;
  if (!r?.status) return { venueDoor: DOOR.UNKNOWN, events: [] };
  const venueDoor =
    { online: DOOR.OPEN, maintenance: DOOR.MAINTENANCE, cancel_only: DOOR.DEGRADED, post_only: DOOR.DEGRADED, limit_only: DOOR.DEGRADED }[
      r.status
    ] ?? DOOR.UNKNOWN;
  const events = (r.upcoming_maintenance ?? []).map((m) => ({
    venue: 'kraken-system',
    sourceId: `sys-${m.event_id}`,
    title: `Scheduled maintenance: ${(m.affected_services ?? []).join(', ')}`,
    category: 'INCIDENT',
    assets: [],
    networks: [],
    functions: (m.affected_services ?? []).some((s) => /trad|ws|rest|engine/i.test(s)) ? ['trading'] : ['unspecified'],
    stage: 'scheduled',
    scheduled: true,
    impact: 'maintenance',
    door: DOOR.MAINTENANCE,
    surpriseScore: 0,
    announcedAt: m.expected_start_utc ?? null,
    stageTimestamps: { scheduledFor: m.expected_start_utc ?? null, scheduledUntil: m.expected_end_utc ?? null },
    observedAt,
  }));
  return { venueDoor, events };
}

// OKX /api/v5/system/status: [{begin, end, state, title, serviceType, ...}].
export function parseOkx(body, observedAt) {
  return (body?.data ?? []).map((m) => ({
    venue: 'okx',
    sourceId: `okx-${m.begin}-${m.title?.slice(0, 20)}`,
    title: m.title ?? 'OKX maintenance',
    assets: extractAssets(m.title ?? ''),
    networks: extractNetworks(m.title ?? ''),
    functions: extractFunctions(m.title ?? ''),
    category:
      extractAssets(m.title ?? '').length || extractFunctions(m.title ?? '').length || extractNetworks(m.title ?? '').length
        ? 'INCIDENT'
        : 'UNPARSED',
    stage: { scheduled: 'scheduled', ongoing: 'in_progress', completed: 'completed', canceled: 'completed' }[m.state] ?? 'unknown',
    scheduled: true,
    impact: 'maintenance',
    door: m.state === 'ongoing' ? DOOR.MAINTENANCE : DOOR.UNKNOWN,
    surpriseScore: 0,
    announcedAt: m.begin ? new Date(Number(m.begin)).toISOString() : null,
    stageTimestamps: {
      scheduledFor: m.begin ? new Date(Number(m.begin)).toISOString() : null,
      scheduledUntil: m.end ? new Date(Number(m.end)).toISOString() : null,
    },
    observedAt,
    raw:
      extractAssets(m.title ?? '').length || extractFunctions(m.title ?? '').length || extractNetworks(m.title ?? '').length
        ? undefined
        : { title: m.title, state: m.state },
  }));
}

// Door matrix for our universe from Kraken's per-asset components + events.
// A coin with no positive evidence stays UNKNOWN — UNKNOWN never becomes OPEN
// on its own; only an operational component or a resolved incident opens it.
export function buildDoorMatrix(universeCoins, krakenComponents, events, prevMatrix = {}) {
  const matrix = {};
  for (const coin of universeCoins) {
    const prev = prevMatrix[coin] ?? {};
    const comps = (krakenComponents ?? []).filter((c) => extractAssets(c.name).includes(coin));
    let funding = prev.funding ?? DOOR.UNKNOWN;
    if (comps.length) {
      const worst = comps.reduce((w, c) => Math.max(w, { operational: 0, degraded_performance: 1, partial_outage: 2, under_maintenance: 2, major_outage: 3 }[c.status] ?? 0), 0);
      funding = [DOOR.OPEN, DOOR.DEGRADED, DOOR.MAINTENANCE, DOOR.CLOSED][worst];
    }
    let trading = prev.trading ?? DOOR.UNKNOWN;
    const touching = events.filter((e) => e.assets.includes(coin) && e.stage !== 'resolved' && e.stage !== 'completed');
    for (const e of touching) {
      if (e.functions.includes('trading')) trading = e.door;
      if (e.functions.includes('deposit') || e.functions.includes('withdrawal') || e.functions.includes('unspecified')) {
        funding = e.door;
      }
    }
    // trading door positive evidence: no touching events + coin trades on our
    // live tape universe -> OPEN was proven by the tape, but that is the
    // tape's claim to make, not the status page's. Leave UNKNOWN here.
    matrix[coin] = { funding, trading, incidents: touching.map((e) => `${e.venue}:${e.sourceId}`) };
  }
  return matrix;
}

// Same asset or network flagged unexpectedly by 2+ venues within the window
// -> network contagion, not venue-local friction.
export function detectContagion(events, windowMs = 30 * 60_000) {
  const flagged = new Set();
  const sudden = events.filter((e) => !e.scheduled && e.category === 'INCIDENT');
  for (const a of sudden) {
    for (const b of sudden) {
      if (a === b || a.venue === b.venue) continue;
      const dt = Math.abs(Date.parse(a.announcedAt ?? a.observedAt) - Date.parse(b.announcedAt ?? b.observedAt));
      if (dt > windowMs) continue;
      const sharedAsset = a.assets.some((x) => b.assets.includes(x));
      const sharedNet = a.networks.some((x) => b.networks.includes(x));
      if (sharedAsset || sharedNet) {
        flagged.add(a.venue + ':' + a.sourceId);
        flagged.add(b.venue + ':' + b.sourceId);
      }
    }
  }
  return flagged; // keys venue:sourceId -> MULTI_VENUE_NETWORK_INCIDENT
}
