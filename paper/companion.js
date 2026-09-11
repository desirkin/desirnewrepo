// SERPENT PAPER — the operator's conversational view into the existing system ("Ask Serpent"). Deterministic, READ-ONLY
// answers built from the same bounded projections the cockpit already shows: the Judge view (/api/judge, bound to the
// running account and mode), the sensor snapshot (/api/sensors), the market research summary and, when a decision is
// outside the projection's latest-12 window, ONE bounded page of the execution journal (read API only).
// Laws: every answer names its evidence timestamp / identifier; a stale or rejected projection is UNVERIFIED /
// UNAVAILABLE, never re-narrated as current; no trade, no qualifying setup, no evaluation record and missing market
// input are four different answers; a reason the Judge did not record is never invented; recorded rationale is kept
// apart from later interpretation; realized and unrealized performance stay on their canonical fields with the period
// and fee basis stated; a disabled Socrates model or a blocked provider is said plainly. Questions are UNTRUSTED text:
// they select an intent and a symbol and nothing else — no path, no command, no tool is ever derived from them.
import { coinFromSymbol } from '../lib/config.js';

export const COMPANION_VERSION = 'serpent-companion-1';
export const COMPANION_LABEL = 'Ask Serpent';
export const INTENTS = Object.freeze(['STATUS', 'WHY_BUY', 'WHY_SKIP', 'WATCH', 'ACCOUNT', 'SENSES', 'HELP']);
export const AVAILABILITY = Object.freeze(['RECORDED', 'UNVERIFIED', 'UNAVAILABLE']);
export const SUGGESTED_QUESTIONS = Object.freeze([
  'What are you doing right now?',
  'Why did you buy this coin?',
  'Why did you skip this coin?',
  'What is The Watch watching on my open position?',
  'How is the paper account doing after costs?',
  'Which senses are working, and which are blocked?',
]);
export const MAX_QUESTION_CHARS = 2000;
export const MAX_HISTORY_TURNS = 8;
export const MAX_HISTORY_CHARS = 1000;
export const JOURNAL_PAGE_LIMIT = 500; // the ONE bounded page read when the latest-12 projection window is not enough
export const READ_ONLY_LAW = 'read-only: this view never places or cancels orders, never initializes or resets an account, never changes a budget, threshold, mode or restriction, never alters evidence';

const STOP = new Set(['WHAT', 'WHY', 'DID', 'YOU', 'THE', 'THIS', 'THAT', 'COIN', 'BUY', 'SKIP', 'SELL', 'ARE', 'DOING', 'RIGHT', 'NOW', 'HOW', 'IS', 'MY', 'OPEN', 'POSITION', 'WATCH', 'WATCHING', 'PAPER', 'ACCOUNT', 'AFTER', 'COSTS', 'COST', 'WHICH', 'SENSES', 'SENSE', 'WORKING', 'AND', 'BLOCKED', 'ON', 'IN', 'OF', 'FOR', 'TO', 'A', 'AN', 'DO', 'NOT', 'ENTER', 'TRADE', 'JUDGE', 'SERPENT', 'FEED', 'MARKET', 'WITH', 'ABOUT', 'TELL', 'ME', 'PLEASE', 'US', 'USD', 'PNL', 'AI', 'LLM', 'OK', 'HI', 'IGNORE', 'ALL', 'PREVIOUS', 'INSTRUCTIONS', 'ORDER', 'PLACE', 'CANCEL', 'RESET', 'ARM', 'LIVE', 'CLEAR', 'KILL', 'CAGE']);
const ALIASES = Object.freeze({ BITCOIN: 'BTC', XBT: 'BTC', ETHER: 'ETH', ETHEREUM: 'ETH', SOLANA: 'SOL', RIPPLE: 'XRP', DOGECOIN: 'DOGE', CARDANO: 'ADA', LITECOIN: 'LTC', CHAINLINK: 'LINK', AVALANCHE: 'AVAX', POLKADOT: 'DOT' });
// eslint-disable-next-line no-control-regex
const clean = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, MAX_QUESTION_CHARS);
const iso = (ts) => (Number.isFinite(ts) ? new Date(ts).toISOString() : 'unknown time');
const short = (id) => (typeof id === 'string' ? id.slice(0, 20) : '—');
// canonical coin of a symbol / pair as the system names it (venue pairs keep their spelling; XBT is Kraken's BTC)
export const canonicalCoinOf = (symbol) => { const c = coinFromSymbol(String(symbol ?? '')).toUpperCase(); return ALIASES[c] ?? c; };
const sameCoin = (a, b) => Boolean(a && b) && canonicalCoinOf(a) === canonicalCoinOf(b);

// ---- question -> intent + symbol (nothing else is ever read from a question) ---------------------------------------------------
export function classify(question) {
  const q = clean(question); const up = q.toUpperCase();
  let symbol = null; const pair = up.match(/\b([A-Z]{2,10})\/(USD|USDT|EUR|USDC)\b/); const cash = up.match(/\$([A-Z]{2,10})\b/);
  if (pair) symbol = canonicalCoinOf(pair[1]); else if (cash) symbol = canonicalCoinOf(cash[1]);
  else { for (const w of up.replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/)) { if (!w || STOP.has(w)) continue; if (ALIASES[w]) { symbol = ALIASES[w]; break; } if (/^[A-Z][A-Z0-9]{1,9}$/.test(w) && q.includes(w)) { symbol = w; break; } } }
  const l = q.toLowerCase();
  let intent = 'HELP';
  if (/\b(sense|senses|sensor|blocked|working|provider|feed|ears?|socrates|disabled)\b/.test(l)) intent = 'SENSES';
  if (/\b(account|p&l|pnl|profit|loss|equity|cash|balance|costs?|fees?|performance|doing after)\b/.test(l)) intent = 'ACCOUNT';
  if (/\bwatch(ing)?\b|\bopen position|\bstop\b|\bexit\b|\bprotection\b/.test(l)) intent = 'WATCH';
  if (/\b(skip|skipped|refuse|refused|didn'?t (buy|enter|trade)|not (buy|enter|trade)|pass(ed)? on|no trade)\b/.test(l)) intent = 'WHY_SKIP';
  else if (/\b(buy|bought|enter|entered|entry|long|took|why did you (get|go))\b/.test(l)) intent = 'WHY_BUY';
  if (/\b(what are you doing|right now|status|currently|up to|going on)\b/.test(l)) intent = 'STATUS';
  return { intent, symbol, question: q };
}

// ---- evidence helpers ------------------------------------------------------------------------------------------------------------
function projectionOf(judge) {
  if (!judge || !judge.enabled) return { p: null, availability: 'UNAVAILABLE', note: 'the Judge is not running in this process (JUDGE_ENABLED is not set or the composition has not started)', ts: null };
  if (judge.rejected) return { p: null, availability: 'UNAVAILABLE', note: `the Judge projection is REJECTED (${judge.rejected}): it belongs to another account or mode and is not evidence about this run`, ts: null };
  const p = judge.projection; if (!p) return { p: null, availability: 'UNAVAILABLE', note: 'no Judge projection has been written yet', ts: null };
  return { p, availability: judge.projectionFresh ? 'RECORDED' : 'UNVERIFIED', note: judge.projectionFresh ? null : `the projection is STALE (written ${iso(p.ts)}); everything below is the last recorded state, not verified current state`, ts: p.ts ?? null };
}
const decisionCoin = (d) => canonicalCoinOf(d?.asset?.pair ?? d?.pair ?? d?.assetId ?? d?.asset?.canonicalCoin ?? '');
const decisionTs = (d) => d?.decisionKnownAtTs ?? d?.decisionTs ?? null;
const decisionStatus = (d) => d?.status ?? d?.state ?? 'UNKNOWN';
const fmtDecision = (d) => `${decisionStatus(d)} on ${d?.asset?.pair ?? d?.pair ?? '?'} via ${d?.setupId ?? '?'} (${d?.inputMode ?? '?'}) at ${iso(decisionTs(d))} [${short(d?.decisionId)}]${(d?.reasonCodes ?? []).length ? ` — recorded reasons: ${d.reasonCodes.join(', ')}` : ' — no refusal clause recorded'}${d?.caseRefs?.caseId ? ` — case ${short(d.caseRefs.caseId)}` : ''}`;
const ENTRY_STATES = new Set(['ENTRY_RESERVED', 'ENTRY_PROPOSED']);
const SKIP_STATES = new Set(['ENTRY_REFUSED', 'NO_TRADE', 'NEEDS_DATA', 'EXPIRED', 'WATCH_CANDIDATE']);

// the ONE bounded journal read: the newest page of DECISION_RECORDED events for a coin (never the whole history)
async function journalDecisions(journalPage, coin) {
  if (typeof journalPage !== 'function') return { rows: null, note: 'no journal read API is attached to this view' };
  try {
    const events = await journalPage({ limit: JOURNAL_PAGE_LIMIT });
    const rows = (Array.isArray(events) ? events : []).map((e) => e?.event ?? e).filter((ev) => ev?.type === 'DECISION_RECORDED' && ev.payload && sameCoin(ev.payload.pair ?? ev.payload.assetId, coin)).map((ev) => ({ ...ev.payload, status: ev.payload.state, asset: { pair: ev.payload.pair }, knownAtTs: ev.knownAtTs ?? null }));
    return { rows, note: `journal page of the newest ${JOURNAL_PAGE_LIMIT} events` };
  } catch (err) { return { rows: null, note: `journal read failed: ${String(err?.message ?? err).slice(0, 120)}` }; }
}

// ---- the answer ------------------------------------------------------------------------------------------------------------------
export async function answerQuestion({ question, judge = null, sensors = null, research = null, journalPage = null, now = Date.now() } = {}) {
  const c = classify(question); const ev = []; const lines = []; let availability = 'RECORDED';
  const { p, availability: pa, note, ts } = projectionOf(judge); if (ts) ev.push({ kind: 'JUDGE_PROJECTION', ts, id: p?.revision !== undefined ? `revision ${p.revision}` : null });
  const bind = p ? `account ${p.accountId} · ${p.accountKind} ${p.runMode} · adapter ${p.adapter}` : null;
  const degrade = (a) => { if (a === 'UNAVAILABLE') availability = 'UNAVAILABLE'; else if (a === 'UNVERIFIED' && availability === 'RECORDED') availability = 'UNVERIFIED'; };
  if (c.intent !== 'SENSES' && c.intent !== 'HELP') { degrade(pa); if (note) lines.push(note); }
  switch (c.intent) {
    case 'STATUS': {
      if (!p) break;
      const open = p.positions ?? []; const cands = p.candidates ?? []; const feed = p.feed ?? null;
      lines.push(`${bind}. Real money DISABLED; live orders DISABLED. Posture: ${p.posture ?? 'COILED (nothing held, nothing pending)'}.`);
      lines.push(feed ? `Market feed: ${feed.connected ? 'CONNECTED' : 'DISCONNECTED'} (epoch ${feed.epoch ?? '—'}, ${feed.admitted ?? 0} admitted, ${feed.pinned ?? 0} pinned).` : 'Market feed: no feed status in the projection.');
      if (!cands.length) lines.push('No candidate is admitted right now: the Judge has nothing to evaluate until the nominations admit a symbol.');
      for (const cd of cands.slice(0, 8)) { const r = cd.readiness ?? {}; const parts = Object.entries(r).map(([setup, rec]) => `${setup} ${rec?.state ?? '—'}${(rec?.missing ?? []).length ? ` (missing: ${rec.missing.map((m) => `${m.id}${m.detail ? ' ' + m.detail : ''}`).join('; ')})` : ''}`); lines.push(`Candidate ${cd.symbol} (${cd.priority ?? '—'}): ${parts.length ? parts.join(' · ') : 'no readiness record yet'}.`); }
      lines.push(open.length ? `Open positions: ${open.map((x) => `${x.pair} ${x.state} (protection ${x.protection}${x.exit?.reason ? `, exit ${x.exit.phase} ${x.exit.reason}` : ''})`).join('; ')}.` : 'No open position.');
      if ((p.restrictions ?? []).length) lines.push(`Restrictions latched: ${p.restrictions.join(', ')} (entries blocked until the owner clears them).`);
      const last = (p.decisions ?? []).at(-1); lines.push(last ? `Last decision: ${fmtDecision(last)}.` : 'No decision has been recorded yet; NO_TRADE would itself be a recorded decision, so this means no setup has completed an evaluation.');
      lines.push('Warm-up law: a candidate needs 61 accepted closed one-minute bars and 21 minutes of continuous trade coverage before a setup can qualify; a gap or restart restarts that clock.');
      break;
    }
    case 'WHY_BUY':
    case 'WHY_SKIP': {
      if (!p) break;
      if (!c.symbol) { lines.push('Name the coin (for example "why did you buy SOL" or "why did you skip BTC/USD") and the recorded decision for it is quoted.'); break; }
      const window = (p.decisions ?? []).filter((d) => sameCoin(decisionCoin(d), c.symbol));
      let rows = window; let source = 'projection (latest 12 decisions)';
      if (!rows.length) { const j = await journalDecisions(journalPage, c.symbol); if (j.rows) { rows = j.rows; source = j.note; } else lines.push(`Not in the latest-12 projection window and ${j.note}: an older decision for ${c.symbol} is outside the available evidence.`); }
      const wanted = c.intent === 'WHY_BUY' ? rows.filter((d) => ENTRY_STATES.has(decisionStatus(d))) : rows.filter((d) => SKIP_STATES.has(decisionStatus(d)));
      const cand = (p.candidates ?? []).find((x) => sameCoin(x.symbol, c.symbol)); const held = (p.positions ?? []).find((x) => sameCoin(x.pair, c.symbol));
      if (wanted.length) { const d = wanted.at(-1); lines.push(`Recorded decision: ${fmtDecision(d)}.`); ev.push({ kind: 'DECISION_RECORDED', ts: decisionTs(d), id: d.decisionId ?? null }); lines.push(`Source: ${source}. The reasons above are exactly the codes the Judge wrote at decision time; anything more would be later interpretation, not the recorded rationale.`); if (d.sizing) lines.push(`Recorded sizing: q ${d.sizing.q} at limit ${d.sizing.entryLimitPrice}, cash out ${d.sizing.entryCashOut}, risk ${d.sizing.riskUsd} USD.`); if (d.inputMode === 'MARKET_DIRECT') lines.push('Input mode MARKET_DIRECT: a market-driven setup that needs no Socrates case.'); else if (d.caseRefs?.caseId) lines.push(`Input mode ${d.inputMode}: bound to sealed case ${short(d.caseRefs.caseId)}.`); }
      else if (c.intent === 'WHY_BUY') { lines.push(held ? `A position in ${held.pair} is held, but no ENTRY decision for it is inside the available evidence (${source}); the entry predates the readable window.` : rows.length ? `No entry was recorded for ${c.symbol}. The latest recorded decision is: ${fmtDecision(rows.at(-1))}.` : cand ? `No decision has been recorded for ${c.symbol} at all: it is an admitted candidate whose setups are ${Object.entries(cand.readiness ?? {}).map(([s, r]) => `${s} ${r?.state ?? '—'}`).join(', ') || 'not yet evaluated'} — no evaluation record exists, so there is no buy to explain.` : `${c.symbol} is not an admitted candidate in this run: no market input is admitted for it, so the Judge never evaluated it.`); }
      else { lines.push(rows.length ? `No refusal was recorded for ${c.symbol}; the latest recorded decision is: ${fmtDecision(rows.at(-1))}.` : cand ? `No decision has been recorded for ${c.symbol}: it is admitted, and its setups are ${Object.entries(cand.readiness ?? {}).map(([s, r]) => `${s} ${r?.state ?? '—'}${(r?.missing ?? []).length ? ` (missing ${r.missing.map((m) => m.id).join(', ')})` : ''}`).join(', ') || 'not yet evaluated'}. That is "no evaluation yet", not a refusal.` : `${c.symbol} is not an admitted candidate: missing market input, not a refusal.`); }
      if (rows.length > 1) lines.push(`Other recorded decisions for ${c.symbol} in this window: ${rows.length - 1}.`);
      break;
    }
    case 'WATCH': {
      if (!p) break;
      const open = p.positions ?? []; const w = p.watch ?? null;
      if (!open.length) { lines.push(`No open position: The Watch supervises ${w?.tracked ?? 0} positions right now (Watch ${w?.watchVersion ?? '—'}${w?.killComplete ? ', KILL complete' : ''}${w?.haltedLatched ? ', HALT latched' : ''}).`); break; }
      for (const x of open) { lines.push(`${x.pair} ${x.state}: held ${x.base}, protection ${x.protection} at trigger ${x.trigger ?? '—'}, structural stop ${x.structuralStop ?? '—'}, initial R ${x.initialR ?? 'not final'}, first fill ${iso(x.firstFillTs)}. Exit: ${x.exit ? `${x.exit.phase}${x.exit.reason ? ' ' + x.exit.reason : ''}` : 'NONE (no exit started)'}. The Watch evaluates deterioration, invalidation, time and feed health on every tick; a feed unusable for more than ten seconds halts with native stops retained.`); ev.push({ kind: 'POSITION', ts: x.firstFillTs ?? ts, id: x.positionId ?? null }); }
      break;
    }
    case 'ACCOUNT': {
      if (!p) break;
      const val = p.valuation ?? {}; const perf = p.performance ?? {}; const real = p.realized ?? null;
      lines.push(`${bind}. Cash ${p.cash ?? 'unknown'}.`);
      lines.push(real ? `Realized P&L ${real.pnl} after ${real.fees} in fees (canonical realized fields).` : 'Realized P&L: the projection carries no realized block (older projection version); the journal is the authority.');
      lines.push(val.unknown ? `Unrealized / equity: UNKNOWN (${val.reason ?? 'no valuation'}) — no usable book for a held position, so no number is invented.` : `Equity ${val.equity ?? '—'} (cash ${val.cashComponent ?? '—'} + liquidation value ${val.liquidationComponent ?? '—'} at ${iso(val.ts)}); unrealized is that liquidation value against the entries.`);
      lines.push(`Session ${perf.session?.date ?? '—'}: day P&L ${perf.session?.dayPnl ?? '—'}, drawdown ${perf.drawdown ?? '—'}, high-water ${perf.highWater ?? '—'}. Period: since this paper account was initialized under policy ${p.policyName ?? '—'} (${(p.policyDigest ?? '').slice(0, 8)}). Fee basis: the reference paper fee schedule of the policy (paper reference rate; not a live account fee).`);
      lines.push('These are the Judge paper account fields, not the legacy ledger totals.');
      break;
    }
    case 'SENSES': {
      if (!sensors || !sensors.enabled) { lines.push('The sensor snapshot is unavailable in this process.'); availability = 'UNAVAILABLE'; break; }
      const rows = sensors.rows ?? []; const on = rows.filter((r) => r.state === 'ACTIVE' || r.state === 'DARK_CAPTURE_OPERATIONAL'); const deg = rows.filter((r) => /DEGRADED|NOT_OBSERVED|KEY_PRESENT_UNPROVEN/.test(r.state)); const blk = rows.filter((r) => /^BLOCKED|CONFIG_REQUIRED|DARK_CAPTURE_BLOCKED/.test(r.state)); const off = rows.filter((r) => /DISABLED_BY_PAPER_POLICY|FOUNDATION_ONLY/.test(r.state));
      lines.push(`Snapshot ${iso(sensors.generatedTs)}: ${on.length} active, ${deg.length} degraded or not yet observed, ${blk.length} blocked, ${off.length} off by paper policy.`); ev.push({ kind: 'SENSOR_SNAPSHOT', ts: sensors.generatedTs ?? null, id: sensors.snapshotVersion ?? null });
      if (on.length) lines.push(`Active: ${on.map((r) => r.id).join(', ')}.`);
      if (deg.length) lines.push(`Degraded / not observed: ${deg.map((r) => `${r.id} ${r.state}`).join(', ')}.`);
      if (blk.length) lines.push(`Blocked: ${blk.map((r) => `${r.id} ${r.state}${r.blocker ? ` (${String(r.blocker).slice(0, 60)})` : ''}`).join('; ')}.`);
      if (off.length) lines.push(`Off by policy: ${off.map((r) => r.id).join(', ')}.`);
      const model = rows.find((r) => r.id === 'SOCRATES_MODEL'); if (model) lines.push(model.state === 'ACTIVE' ? 'The Socrates model is enabled under explicit caps.' : `The Socrates model is ${model.state}: sealed cases seal without a model; the market-driven setups need no model.`);
      if (research && research.enabled === false) lines.push('The market research service has not published a status record.');
      break;
    }
    default: {
      lines.push(`I answer from the recorded evidence only. Try: ${SUGGESTED_QUESTIONS.join(' · ')}`);
    }
  }
  if (c.intent !== 'HELP' && c.intent !== 'SENSES' && !p) lines.push('Nothing else can be said about this run without a Judge projection.');
  const answer = lines.join('\n');
  return { ok: true, version: COMPANION_VERSION, intent: c.intent, symbol: c.symbol, availability, evidence: ev, answer, law: READ_ONLY_LAW, generatedTs: now };
}

// bounded, sanitized conversation history (only what the client sent back; the server keeps no transcript)
export function boundHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-MAX_HISTORY_TURNS).map((h) => ({ role: h?.role === 'assistant' ? 'assistant' : 'user', text: clean(h?.text).slice(0, MAX_HISTORY_CHARS) })).filter((h) => h.text.length);
}
