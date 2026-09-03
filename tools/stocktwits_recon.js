// S-1 — StockTwits reconnaissance. Standalone; NOT wired into the engine.
// Polite unauthenticated probes of the public symbol-stream API to learn what
// works without keys, what the limits are, and how wide crypto coverage runs.
// Politeness contract: >= 2s between requests, hard cap 30 requests per run.
import path from 'node:path';
import { loadConfig, dataDir } from '../lib/config.js';
import { atomicWriteJson } from '../lib/jsonl.js';
import { nowIso } from '../lib/time.js';

const BASE = 'https://api.stocktwits.com/api/2/streams/symbol';
const MAJORS = ['BTC.X', 'ETH.X', 'SOL.X', 'XRP.X', 'DOGE.X'];
const LONG_TAIL = ['ADA.X', 'ZEC.X', 'UNI.X', 'XMR.X', 'SUI.X', 'CRV.X', 'TAO.X', 'PEPE.X', 'SHIB.X', 'LINK.X'];
const MAX_REQUESTS = 30;
const SPACING_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RATE_HEADER_NAMES = [
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'retry-after',
  'ratelimit-limit',
  'ratelimit-remaining',
];

function pickRateHeaders(headers) {
  const out = {};
  for (const name of RATE_HEADER_NAMES) {
    const v = headers.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

async function probe(symbol) {
  const url = `${BASE}/${symbol}.json`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { accept: 'application/json' },
    });
    const rateHeaders = pickRateHeaders(res.headers);
    let body = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON body recorded as such
    }
    const messages = body?.messages ?? [];
    const withSentiment = messages.filter((m) => m?.entities?.sentiment?.basic);
    const sentiments = {};
    for (const m of withSentiment) {
      const s = m.entities.sentiment.basic;
      sentiments[s] = (sentiments[s] ?? 0) + 1;
    }
    return {
      symbol,
      url,
      httpStatus: res.status,
      ok: res.ok,
      latencyMs: Date.now() - started,
      rateHeaders,
      authRequired: res.status === 401 || res.status === 403,
      responseShape: body
        ? {
            topLevelKeys: Object.keys(body),
            symbolResolved: body.symbol?.symbol ?? null,
            symbolTitle: body.symbol?.title ?? null,
            watchlistCount: body.symbol?.watchlist_count ?? null,
            messageCount: messages.length,
            messageKeys: messages[0] ? Object.keys(messages[0]) : [],
            newestTs: messages[0]?.created_at ?? null,
            oldestTs: messages.at(-1)?.created_at ?? null,
            sentimentLabeled: withSentiment.length,
            sentimentBreakdown: sentiments,
            cursor: body.cursor ?? null,
            apiError: body.errors ?? null,
          }
        : { note: 'non-JSON or empty body' },
    };
  } catch (err) {
    return { symbol, url, httpStatus: null, ok: false, error: err.message, latencyMs: Date.now() - started };
  }
}

const results = [];
const plan = [...MAJORS, ...LONG_TAIL].slice(0, MAX_REQUESTS);
console.log(`S-1 recon: ${plan.length} probes, ${SPACING_MS}ms spacing, cap ${MAX_REQUESTS}. No engine wiring.`);
for (const [i, symbol] of plan.entries()) {
  const r = await probe(symbol);
  results.push(r);
  const shape = r.responseShape ?? {};
  console.log(
    `  [${i + 1}/${plan.length}] ${symbol}: HTTP ${r.httpStatus ?? 'ERR'}${r.error ? ` (${r.error})` : ''}` +
      (r.ok
        ? ` — ${shape.messageCount} msgs, ${shape.sentimentLabeled} sentiment-labeled, watchers ${shape.watchlistCount ?? '?'}`
        : '')
  );
  if (i < plan.length - 1) await sleep(SPACING_MS);
}

const okCount = results.filter((r) => r.ok).length;
const authWalled = results.filter((r) => r.authRequired).length;
const rateHeaderSample = results.find((r) => r.rateHeaders && Object.keys(r.rateHeaders).length)?.rateHeaders ?? {};
const majorsOk = results.filter((r) => MAJORS.includes(r.symbol) && r.ok).length;
const tailOk = results.filter((r) => LONG_TAIL.includes(r.symbol) && r.ok).length;

const report = {
  generatedAt: nowIso(),
  contract: { spacingMs: SPACING_MS, maxRequests: MAX_REQUESTS, requestsMade: results.length },
  summary: {
    reachableUnauthenticated: okCount,
    authRequired: authWalled,
    majorsCoverage: `${majorsOk}/${MAJORS.length}`,
    longTailCoverage: `${tailOk}/${LONG_TAIL.length}`,
    observedRateHeaders: rateHeaderSample,
    recommendedPollingBudget:
      'No rate-limit headers advertised; StockTwits documents ~200 req/hour unauthenticated (429 on breach). ' +
      'Budget conservatively at <=120 req/hour total: majors + STALKING symbols every 5 min (~60/hr for 5), ' +
      'long-tail lazy rotation filling the remainder; back off 15 min on any 429.',
  },
  probes: results,
};
atomicWriteJson(path.join(dataDir(loadConfig()), 'recon', 'stocktwits_report.json'), report, { pretty: true });

console.log('\n=== SUMMARY ===');
console.log(`unauthenticated OK: ${okCount}/${results.length} (majors ${majorsOk}/5, long tail ${tailOk}/10)`);
console.log(`auth-walled (401/403): ${authWalled}`);
console.log(`rate-limit headers observed: ${JSON.stringify(rateHeaderSample)}`);
console.log(`report: data/recon/stocktwits_report.json`);
