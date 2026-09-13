import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'tools', 'data-only-runtime.mjs');
const forbidden = [
  `${path.sep}fly.js`, `${path.sep}paper${path.sep}`, `${path.sep}judge${path.sep}`,
  `${path.sep}execution${path.sep}`, `${path.sep}watch${path.sep}`, `${path.sep}tape${path.sep}run.js`,
  `${path.sep}bin${path.sep}cobra.js`,
];

function importGraph(file, seen = new Set()) {
  const absolute = path.resolve(file);
  if (seen.has(absolute)) return seen;
  seen.add(absolute);
  const source = readFileSync(absolute, 'utf8');
  const specs = [...source.matchAll(/(?:from\s*|import\s*\()(['"])(\.{1,2}\/[^'"]+)\1/g)].map((match) => match[2]);
  for (const spec of specs) {
    let next = path.resolve(path.dirname(absolute), spec);
    if (!path.extname(next)) next += '.js';
    importGraph(next, seen);
  }
  return seen;
}

test('data-only entrypoint import graph contains no trading composition or order runtime', () => {
  const graph = [...importGraph(entry)];
  for (const file of graph) for (const denied of forbidden) assert.equal(file.includes(denied), false, `forbidden data-only dependency: ${file}`);
  const source = readFileSync(entry, 'utf8');
  assert.match(source, /JUDGE_ENABLED:\s*'false'/);
  assert.match(source, /JUDGE_ALLOW_ORDERS:\s*'false'/);
  assert.match(source, /nominationEnabled:\s*false/);
  assert.match(source, /maxMonthlyUsd:\s*0/);
});

test('data-only launcher derives official/social scope from the accepted catalog without a named fallback', () => {
  const source = readFileSync(entry, 'utf8');
  assert.match(source, /catalog\.markets\.map\(\(market\) => market\.base\)/);
  assert.doesNotMatch(source, /\b(?:BTC|ETH|SOL)\b/);
  assert.match(source, /namedPreference:\s*false/);
});

test('data-only launcher starts and reports zero-order market observations with its own guarded transport', () => {
  const source = readFileSync(entry, 'utf8');
  assert.match(source, /import\('\.\/data-only-market\.mjs'\)/);
  assert.match(source, /market = await startDataOnlyMarket\(\{ env: process\.env, dataDir: root, log, quotaJournal: checkpoints\.market \}\)/);
  assert.match(source, /handles\.push\(market\)/);
  assert.match(source, /market:\s*market\?\.status\?\.\(\)/);
  assert.match(source, /blockers\.MARKET/);
});

test('outer market funnel subscribes the complete accepted catalog independently of the deep subject list', () => {
  const source = readFileSync(entry, 'utf8');
  assert.match(source, /import\('\.\.\/market-lab\/broad-kraken\.js'\)/);
  assert.match(source, /broadMarket = await startBroadKraken\(\{ catalogSource, dataDir: root, log \}\)/);
  assert.match(source, /handles\.push\(broadMarket\)/);
  assert.match(source, /broadMarket:\s*broadMarket\?\.status\?\.\(\)/);
  assert.match(source, /blockers\.BROAD_MARKET/);
  assert.ok(source.indexOf('await wideEye._refreshCatalog()') < source.indexOf('await startBroadKraken('));
  assert.ok(source.indexOf('await openDataOnlyCheckpoints(') < source.indexOf('await startBroadKraken('));
  assert.doesNotMatch(source, /\b(?:BTC|ETH|SOL)\b|composeDataOnlySocialConfig/);
});

test('data-only deployment composes the existing YouTube collector behind explicit fail-closed gates and durable status', () => {
  const source = readFileSync(entry, 'utf8');
  const supervisor = readFileSync(path.join(root, 'tools', 'data-only-with-ui.mjs'), 'utf8');
  for (const text of [source, supervisor]) {
    assert.match(text, /SOCIAL_VIDEO_ENABLED:\s*process\.env\.SOCIAL_VIDEO_ENABLED === 'true' \? 'true' : 'false'/);
    assert.doesNotMatch(text, /SOCIAL_VIDEO_ENABLED:\s*'true'/, 'the launcher must not invent YouTube authorization');
  }
  assert.match(source, /import\('\.\.\/video\/collector\.js'\)/);
  assert.match(source, /import\('\.\.\/video\/reader\.js'\)/);
  assert.match(source, /startVideo\(\{ env: process\.env, dataDir: root, log, signals: false, durableCheckpoint: checkpoints\?\.video \?\? null \}\)/);
  assert.match(source, /blockers\.YOUTUBE/);
  assert.match(source, /youtube:\s*video \? readVideoStatus\(root\)/);
  assert.match(source, /handles\.push\(video\)/, 'normal shutdown must stop the YouTube handle');
});

test('data-only news uses official feeds plus bounded GDELT metadata and withholds unverified publisher text', () => {
  const source = readFileSync(entry, 'utf8');
  assert.doesNotMatch(source, /startPress|readPressStatus|PRESS_ENABLED:\s*'true'/);
  assert.doesNotMatch(source, /COINDESK_NEWS|THEBLOCK_NEWS|COINTELEGRAPH_NEWS|DECRYPT_NEWS/);
  assert.match(source, /state:\s*'WITHHELD_TERMS_UNVERIFIED'/);
  assert.match(source, /excerptsStored:\s*false/);
  assert.match(source, /publisherFulltextStored:\s*false/);
  assert.match(source, /publisherExcerptsStored:\s*false/);
  assert.match(source, /DISCOVERY_SOURCES:\s*'GDELT_NEWS_DISCOVERY,POLYMARKET_PUBLIC_DATA,KALSHI_PUBLIC_DATA'/);
  assert.match(source, /DISCOVERY_GDELT_MAX_DAILY_REQUESTS:\s*'16'/);
  assert.match(source, /DISCOVERY_POLYMARKET_MAX_DAILY_REQUESTS:\s*'48'/);
  assert.match(source, /DISCOVERY_KALSHI_MAX_DAILY_REQUESTS:\s*'48'/);
  assert.match(source, /DISCOVERY_GDELT_RESULT_LIMIT:\s*'50'/);
  assert.match(source, /DISCOVERY_GDELT_ASSETS_PER_QUERY:\s*'12'/);
  assert.match(source, /contact:\s*process\.env\.SERPENT_HTTP_CONTACT \?\? null/);
  assert.match(source, /edgarEnabled:\s*false/);
  assert.match(source, /CFTC_OFFICIAL:\s*officialFeed\('CFTC_OFFICIAL'\)/);
  assert.match(source, /SEC_OFFICIAL:\s*officialFeed\('SEC_OFFICIAL'\)/);
  assert.match(source, /GDELT_NEWS_DISCOVERY:/);
});

test('Replit run and deployment commands select the data-only supervisor, not the paper runtime', () => {
  const replit = readFileSync(path.join(root, '.replit'), 'utf8');
  const supervisor = readFileSync(path.join(root, 'tools', 'data-only-with-ui.mjs'), 'utf8');
  assert.match(replit, /^run = "npm run data:only-ui"/m);
  assert.match(replit, /\[deployment\][\s\S]*run = \["npm", "run", "data:only-ui"\]/);
  assert.doesNotMatch(replit, /npm run paper|paper run/);
  assert.match(supervisor, /let terminalExitCode = null/);
  assert.match(supervisor, /process\.exit\(terminalExitCode \?\? 0\)/);
  assert.match(supervisor, /const SHUTDOWN_GRACE_MS = 60_000/);
  assert.doesNotMatch(supervisor, /}, 10_000\)\.unref\(\)/, 'supervisor grace must exceed bounded collector drains');
});

test('both data-only launchers explicitly keep paid X collection disabled during broad-market rollout', () => {
  for (const file of [entry, path.join(root, 'tools', 'data-only-with-ui.mjs')]) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /RUMOR2_SOCIAL_X_ENABLED:\s*'false'/);
    assert.doesNotMatch(source, /RUMOR2_SOCIAL_X_ENABLED:\s*'true'/);
  }
});

test('startup publishes process identity and restores external quotas before any provider starts', () => {
  const source = readFileSync(entry, 'utf8');
  const initialStatus = source.indexOf('writeStartupStatus();');
  const persistenceStart = source.indexOf('await startPersistence({ log, registerSignals: false })');
  const checkpointStart = source.indexOf('await openDataOnlyCheckpoints(');
  const marketStart = source.indexOf('await startDataOnlyMarket(');
  const wideEyeStart = source.indexOf('wideEye = startWideEye(');
  assert.ok(initialStatus > 0 && initialStatus < persistenceStart);
  assert.ok(persistenceStart < checkpointStart && checkpointStart < marketStart && checkpointStart < wideEyeStart);
  assert.doesNotMatch(source, /await wideEye\._sweepOnce\(\)/);
  assert.match(source, /openedTs: startedTs/);
  assert.match(source, /durableCheckpoint: checkpoints\.discovery/);
  assert.ok(source.indexOf('await checkpoints?.close?.()') < source.indexOf('await persistence?.stop?.()'));
});
