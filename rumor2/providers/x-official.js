// SOCIAL-2B — X / Twitter provider: the CURRENT official X API v2 Filtered
// Stream (pinned 2026-09-06 against docs.x.com). This module is PURE: it maps
// one stream line ({ data, matching_rules }) to the shared social `raw` shape,
// compiles Serpent's deterministic bounded rule manifest, and builds the exact
// request URLs. The bounded HTTP streaming transport lives in rumor2/x-stream.js
// and the cost governor / durable runtime in rumor2/x-runtime.js. No network
// here; no credential is ever read here.
//
// CURRENT OFFICIAL CONTRACT (2026-09-06):
//   stream   GET  https://api.x.com/2/tweets/search/stream
//   rules    GET/POST https://api.x.com/2/tweets/search/stream/rules  (?dry_run=true)
//            GET  https://api.x.com/2/tweets/search/stream/rules/counts
//   usage    GET  https://api.x.com/2/usage/tweets ; GET https://api.x.com/2/usage/credits
//   auth     OAuth2 App-Only Bearer token (Authorization header only)
//   limits   Pay-per-use: 1 connection/project, 1,000 rules/project, 1,024 chars/rule
//   delivery near-real-time (~4-5 s P99); blank CRLF keepalive ~every 20 s;
//            no data/keepalive for 20 s => reconnect; backfill_minutes = 0..5
//   pricing  Post read $0.005 / returned Post resource; User read $0.010 / returned
//            User resource; self-serve cap 3,000,000 Post reads per monthly cycle;
//            same-resource billing dedupe within a UTC day is SOFT — never relied on.
//   edits    every edit creates a NEW Post id; the stream carries edit_history_tweet_ids.
//
// X IS NOT THE WHOLE FIREHOSE (§6): X server-side rules are the FIRST cost/noise
// boundary, Serpent's universe filter the SECOND, RUMOR analysis the THIRD.
import { createHash } from 'node:crypto';

// Local, dependency-free hashing: the provider layer imports nothing from the
// rumor core (R2A-75). Same canonical form + sha1-hex as rumor2/truth.js.
const canonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => (v[k] === undefined ? null : `${JSON.stringify(k)}:${canonicalJson(v[k])}`)).filter(Boolean).join(',')}}`;
};
const contentHash = (text) => createHash('sha1').update(String(text)).digest('hex');

export const X_OFFICIAL = Object.freeze({
  id: 'X_OFFICIAL',
  providerKind: 'SOCIAL_MICROBLOG',
  organization: 'X_CORP',
  hosts: Object.freeze(['api.x.com']), // exact allowlist — the only host any X request may target
  streamPath: '/2/tweets/search/stream',
  rulesPath: '/2/tweets/search/stream/rules',
  rulesCountsPath: '/2/tweets/search/stream/rules/counts',
  usageTweetsPath: '/2/usage/tweets',
  usageCreditsPath: '/2/usage/credits',
  credentialEnv: 'X_BEARER_TOKEN', // the NAME only; the value is never embedded or logged
  limits: Object.freeze({ connectionsPerProject: 1, rulesPerProject: 1000, ruleMaxChars: 1024, backfillMinutesMax: 5, keepaliveSec: 20, stallSec: 20, p99LatencySec: 5 }),
  pricing: Object.freeze({
    postReadUsd: 0.005, userReadUsd: 0.01, monthlyPostReadCap: 3_000_000,
    billingDedupe: 'SOFT_UTC_DAY', observedOn: '2026-09-06', source: 'https://docs.x.com/x-api/getting-started/pricing',
  }),
  // ONLY the Post fields SOCIAL-2B needs. NO expansions, NO user.fields, NO
  // referenced-Post expansion: X bills returned User resources separately and
  // expanded Posts multiply billable resources. author_id rides in the Post.
  postFields: Object.freeze(['id', 'text', 'author_id', 'created_at', 'edit_history_tweet_ids', 'referenced_tweets', 'conversation_id', 'lang', 'public_metrics', 'entities', 'possibly_sensitive', 'withheld']),
  tagPrefix: 'serpent:v1:',
  lanes: Object.freeze(['origin', 'event', 'account', 'propagation']),
  maxOwnedRules: 200, // far below the 1,000/project platform maximum
  maxAssetsPerRule: 10,
});

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isIdStr = (v) => typeof v === 'string' && /^[0-9]{1,40}$/.test(v);

// ---- request URLs ------------------------------------------------------------
// The stream URL: exact host, minimal billable fields, optional backfill (0..5).
export function xStreamUrl({ backfillMinutes = 0 } = {}) {
  const params = [`tweet.fields=${encodeURIComponent(X_OFFICIAL.postFields.join(','))}`];
  if (Number.isSafeInteger(backfillMinutes) && backfillMinutes > 0) params.push(`backfill_minutes=${Math.min(X_OFFICIAL.limits.backfillMinutesMax, backfillMinutes)}`);
  return `https://${X_OFFICIAL.hosts[0]}${X_OFFICIAL.streamPath}?${params.join('&')}`;
}
export const xRulesUrl = ({ dryRun = false } = {}) => `https://${X_OFFICIAL.hosts[0]}${X_OFFICIAL.rulesPath}${dryRun ? '?dry_run=true' : ''}`;
export const xRulesCountsUrl = () => `https://${X_OFFICIAL.hosts[0]}${X_OFFICIAL.rulesCountsPath}`;
export const xUsageUrl = () => `https://${X_OFFICIAL.hosts[0]}${X_OFFICIAL.usageTweetsPath}`;
export const xCreditsUrl = () => `https://${X_OFFICIAL.hosts[0]}${X_OFFICIAL.usageCreditsPath}`;
export function assertXHost(url) {
  const h = new URL(url).host;
  if (!X_OFFICIAL.hosts.includes(h)) throw new Error('x-official: host not in the approved X host allowlist');
  return url;
}

// ---- rule tags / ownership ---------------------------------------------------
// Serpent-owned rules carry a deterministic tag: serpent:v1:<lane>:<hash16>.
// Any other tag is UNOWNED and is never modified or deleted by Serpent.
export const xRuleTag = (lane, value) => `${X_OFFICIAL.tagPrefix}${lane}:${contentHash(value).slice(0, 16)}`;
export const isSerpentTag = (tag) => typeof tag === 'string' && tag.startsWith(X_OFFICIAL.tagPrefix) && /^serpent:v1:(origin|event|account|propagation):[0-9a-f]{16}$/.test(tag);
export const xLaneOfTag = (tag) => (isSerpentTag(tag) ? tag.split(':')[2] : null);
export const xRuleSetHash = (rules) => contentHash(canonicalJson([...rules].map((r) => ({ value: r.value, tag: r.tag })).sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))));

// ---- the deterministic bounded rule manifest (§17) ---------------------------
// LANE A origin/discovery — ticker/cashtag anchored, -is:retweet (no echo cost)
// LANE B event/catalyst  — universe term × bounded high-information vocabulary
// LANE C accounts        — configured approved accounts only (from:)
// LANE D propagation     — OPTIONAL narrow focus set where echo traffic is
//                          intentionally allowed; EMPTY by default
// Never a blank rule, never a whole-firehose rule, never a naked catch-all term.
export const X_EVENT_TERMS = Object.freeze([
  'listing', 'listed', 'delisting', 'delisted',
  'exploit', 'hacked', 'drained', 'breach',
  'deposits', 'withdrawals', 'suspended', 'resumed',
  'outage', 'halted',
  'ETF', 'approval', 'approved', 'denied',
  'lawsuit', 'SEC', 'CFTC',
  'unlock', 'burn', 'mainnet', 'launch',
]);
// naked catch-all terms that may NEVER stand alone as a rule anchor (a named
// asset such as "bitcoin" may appear only paired with a bounded event context)
export const X_FORBIDDEN_NAKED_TERMS = Object.freeze(['crypto', 'cryptocurrency', 'bitcoin', 'ethereum', 'coin', 'token', 'altcoin', 'pump', 'moon', 'memecoin', 'nft', 'defi', 'web3']);
// generic words the compiler never uses as an anchor at all — not even paired
export const X_GENERIC_TERMS = Object.freeze(['crypto', 'cryptocurrency', 'coin', 'token', 'altcoin', 'pump', 'moon', 'memecoin', 'nft', 'defi', 'web3']);
const TICKER_RE = /^[A-Z0-9]{2,15}$/;
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

export function compileXRuleManifest({ universe = [], aliases = [], priorityAccounts = [], propagationFocus = [] } = {}) {
  const tickers = [...new Set((Array.isArray(universe) ? universe : []).filter((t) => typeof t === 'string' && TICKER_RE.test(t)))].sort();
  const aliasWords = [...new Set((Array.isArray(aliases) ? aliases : []).map((a) => String(a).toLowerCase()).filter((a) => /^[a-z][a-z0-9]{2,20}$/.test(a) && !X_GENERIC_TERMS.includes(a)))].sort();
  const accounts = [...new Set((Array.isArray(priorityAccounts) ? priorityAccounts : []).map((h) => String(h).replace(/^@/, '')).filter((h) => HANDLE_RE.test(h)))].sort();
  const focus = [...new Set((Array.isArray(propagationFocus) ? propagationFocus : []).filter((t) => typeof t === 'string' && TICKER_RE.test(t) && tickers.includes(t)))].sort();
  const rules = [];
  const add = (lane, value) => rules.push({ lane, value, tag: xRuleTag(lane, value) });
  // LANE A — origin/discovery: ($BTC OR #BTC ...) -is:retweet
  for (const group of chunk(tickers, X_OFFICIAL.maxAssetsPerRule)) add('origin', `(${group.map((t) => `$${t} OR #${t}`).join(' OR ')}) -is:retweet`);
  // LANE B — event/catalyst: (BTC OR bitcoin ...) (listing OR exploit ...) -is:retweet
  const eventVocab = `(${X_EVENT_TERMS.join(' OR ')})`;
  const assetTerms = [...tickers, ...aliasWords];
  for (const group of chunk(assetTerms, X_OFFICIAL.maxAssetsPerRule)) add('event', `(${group.join(' OR ')}) ${eventVocab} -is:retweet`);
  // LANE C — approved accounts (a watched account may enter without an asset token)
  for (const group of chunk(accounts, X_OFFICIAL.maxAssetsPerRule)) add('account', `(${group.map((h) => `from:${h}`).join(' OR ')})`);
  // LANE D — propagation focus: echoes intentionally allowed, bounded, default EMPTY
  for (const group of chunk(focus, X_OFFICIAL.maxAssetsPerRule)) add('propagation', `(${group.map((t) => `$${t} OR #${t}`).join(' OR ')})`);
  return { rules, hash: xRuleSetHash(rules), lanes: { origin: rules.filter((r) => r.lane === 'origin').length, event: rules.filter((r) => r.lane === 'event').length, account: rules.filter((r) => r.lane === 'account').length, propagation: rules.filter((r) => r.lane === 'propagation').length } };
}

// RULE SAFETY (§19): every desired rule must be non-blank, within the platform
// length, anchored (ticker/cashtag/hashtag/alias/account — never a bare
// operator-only or catch-all rule), and the whole manifest bounded.
export function validateXRuleManifest(rules) {
  if (!Array.isArray(rules)) return 'manifest: not a list';
  if (rules.length === 0) return 'manifest: no rules (nothing to listen for)';
  if (rules.length > X_OFFICIAL.maxOwnedRules) return `manifest: ${rules.length} rules exceeds Serpent bound ${X_OFFICIAL.maxOwnedRules}`;
  const tags = new Set();
  for (const r of rules) {
    if (!r || typeof r.value !== 'string' || r.value.trim().length === 0) return 'manifest: blank rule';
    if (r.value.length > X_OFFICIAL.limits.ruleMaxChars) return `manifest: rule exceeds ${X_OFFICIAL.limits.ruleMaxChars} chars`;
    if (!X_OFFICIAL.lanes.includes(r.lane)) return 'manifest: unknown lane';
    if (r.tag !== xRuleTag(r.lane, r.value) || !isSerpentTag(r.tag)) return 'manifest: tag is not the deterministic Serpent-owned tag';
    if (tags.has(r.tag)) return 'manifest: duplicate rule';
    tags.add(r.tag);
    // whole-firehose / operator-only guard: strip operators and require an anchor
    const stripped = r.value.replace(/-?is:\w+|has:\w+|lang:\w+|sample:\d+|-?is:nullcast/g, '').replace(/[()]/g, ' ').replace(/\bOR\b/g, ' ').trim();
    if (stripped.length === 0) return 'manifest: whole-firehose rule (no content anchor)';
    const anchors = stripped.split(/\s+/).filter(Boolean);
    const anchored = anchors.some((a) => /^[$#][A-Z0-9]{2,15}$/.test(a) || /^from:[A-Za-z0-9_]{1,15}$/.test(a) || TICKER_RE.test(a) || /^[a-z][a-z0-9]{2,20}$/.test(a));
    if (!anchored) return 'manifest: rule is not anchored to a universe term or approved account';
    // a naked catch-all term as the ONLY content is forbidden
    const words = anchors.map((a) => a.toLowerCase());
    if (words.every((w) => X_FORBIDDEN_NAKED_TERMS.includes(w))) return `manifest: naked catch-all rule (${words.join(' ')})`;
    if (r.lane === 'origin' && !/-is:retweet/.test(r.value)) return 'manifest: origin lane must exclude retweets';
  }
  return null;
}

// ---- stream line -> shared raw observation (§22-§27) ------------------------
// One newline-delimited stream line: { data: Post, matching_rules: [{id, tag}] }.
// Pure and total: adversarial input is a skip, never a throw.
export function xPostToRaw(line, { provider = 'X_OFFICIAL' } = {}) {
  if (line === null || typeof line !== 'object') return { skip: true, reason: 'not an object' };
  const d = line.data;
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return { skip: true, reason: 'no Post data' };
  if (!isIdStr(d.id) || !isIdStr(d.author_id)) return { skip: true, reason: 'Post without id/author_id' };
  // STABLE POST IDENTITY across edits (§22): the FIRST id in edit_history_tweet_ids;
  // the CURRENT id is the immutable version. CREATE when current == first, else EDIT.
  const history = Array.isArray(d.edit_history_tweet_ids) ? d.edit_history_tweet_ids.filter(isIdStr) : [];
  const originalId = history.length > 0 ? history[0] : d.id;
  const editState = originalId === d.id ? 'ORIGINAL' : (history.includes(d.id) ? 'EDITED' : 'ORIGINAL');
  // RELATIONSHIP (§24): conservative provider-native mapping, no fabrication.
  // exactly one reference => mapped; none => ORIGINAL; multiple or unknown types
  // => UNKNOWN with no parent (the thread is still preserved via conversation_id).
  const refs = Array.isArray(d.referenced_tweets) ? d.referenced_tweets.filter((r) => r && typeof r === 'object' && isStr(r.type) && isIdStr(r.id)) : [];
  let relation = 'ORIGINAL';
  let parentNativePostId = null;
  if (refs.length === 1) {
    const map = { retweeted: 'REPOST', quoted: 'QUOTE', replied_to: 'REPLY' };
    relation = map[refs[0].type] ?? 'UNKNOWN';
    parentNativePostId = relation === 'UNKNOWN' ? null : refs[0].id;
  } else if (refs.length > 1) relation = 'UNKNOWN';
  const created = isStr(d.created_at) ? Date.parse(d.created_at) : NaN;
  const pm = d.public_metrics && typeof d.public_metrics === 'object' ? d.public_metrics : {};
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  // INGRESS TAGS (§27): only the tags X actually returned; Serpent-owned tags
  // verbatim, anything else classified as external/unowned (never stored raw)
  const mr = Array.isArray(line.matching_rules) ? line.matching_rules : [];
  const ingressTags = [...new Set(mr.map((m) => (m && typeof m === 'object' && isStr(m.tag) ? (isSerpentTag(m.tag) ? m.tag : 'external:unowned') : null)).filter(Boolean))].sort();
  return {
    raw: {
      provider, providerKind: 'SOCIAL_MICROBLOG',
      nativePostId: originalId, nativeAuthorId: d.author_id,
      text: typeof d.text === 'string' ? d.text : '',
      relation, parentNativePostId, editState,
      canonicalUrl: `https://x.com/i/status/${d.id}`,
      threadId: isIdStr(d.conversation_id) ? d.conversation_id : originalId,
      nativeVersionId: d.id,
      providerEventSeq: null, // X has no sequence cursor — never invented (§28)
      providerEventTs: null, // the stream payload carries no distinct provider event clock (§25)
      handle: null, // no User resource is requested in SOCIAL-2B (§23/§42)
      displayName: null,
      sourceDeclaredTs: Number.isFinite(created) ? created : null, // client/source-declared; quarantine law applies
      engagement: { likes: count(pm.like_count), reposts: count(pm.retweet_count), replies: count(pm.reply_count), quotes: count(pm.quote_count), views: count(pm.impression_count) },
      authorMeta: null, // no $0.010 User reads in SOCIAL-2B (§42)
      ingressTags,
    },
  };
}

// Parse the current official usage response (§12) into a CLOSED shape or null.
//   { data: { project_usage, project_cap, cap_reset_day, daily_project_usage: [...] } }
export function parseXUsage(body, { observedTs }) {
  const d = body && typeof body === 'object' ? body.data : null;
  if (!d || typeof d !== 'object') return null;
  const int = (v) => { const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v; return Number.isSafeInteger(n) && n >= 0 ? n : null; };
  const projectUsage = int(d.project_usage);
  const projectCap = int(d.project_cap);
  if (projectUsage === null || projectCap === null) return null;
  const capResetDay = int(d.cap_reset_day);
  let dailyProjectUsage = null;
  if (Array.isArray(d.daily_project_usage)) {
    for (const entry of d.daily_project_usage) {
      const usage = Array.isArray(entry?.usage) ? entry.usage : [];
      for (const u of usage) { const n = int(u?.usage); if (n !== null) dailyProjectUsage = Math.max(dailyProjectUsage ?? 0, n); }
    }
  }
  return { projectUsage, projectCap, capResetDay: capResetDay !== null && capResetDay >= 1 && capResetDay <= 31 ? capResetDay : null, dailyProjectUsage, observedTs: Math.floor(observedTs) };
}
// Parse the current official credits response (§13): { data: { free_balance, prepaid_balance, total_balance } }
export function parseXCredits(body) {
  const d = body && typeof body === 'object' ? body.data : null;
  if (!d || typeof d !== 'object') return null;
  const num = (v) => { const n = typeof v === 'string' ? Number(v) : v; return Number.isFinite(n) ? n : null; };
  const total = num(d.total_balance);
  if (total === null) return null;
  return { freeBalance: num(d.free_balance), prepaidBalance: num(d.prepaid_balance), totalBalance: total };
}
