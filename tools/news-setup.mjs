// News-only collection. No fly.js, tape, account, order or paid API startup.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDir as defaultDataDir } from '../lib/config.js';
import { loadProfile } from '../paper/profile.js';
import { startPress } from '../press/collector.js';
import { PRESS_SOURCES } from '../press/registry.js';

const noTimers = { setTimeout: () => null, clearTimeout() {}, setInterval: () => null, clearInterval() {} };

export async function setupNews({ profile = loadProfile(), env = process.env, dataDir = defaultDataDir(), watch = false, fetchImpl = fetch, clock = () => Date.now(), log = console.log } = {}) {
  const selected = PRESS_SOURCES.filter(s => s.route === 'RSS' && profile.groups.publisherNews[s.id]?.desiredState === 'ON');
  // Copy only the public contact field. A token or an unrelated enable flag can
  // never escape into this credential-free collector or turn on another API.
  const pressEnv = { PRESS_ENABLED: selected.length ? 'true' : 'false', PRESS_SOURCES: selected.map(s => s.id).join(','), SERPENT_HTTP_CONTACT: env.SERPENT_HTTP_CONTACT ?? '' };
  const timers = watch ? { ...noTimers, setInterval, clearInterval } : noTimers;
  const handle = startPress({ env: pressEnv, dataDir, fetchImpl, clock, timers, signals: true, log });
  try {
    if (handle) for (const source of selected) await handle.pollOnce(source.id);
    const status = handle?.status();
    const rows = PRESS_SOURCES.map(source => {
      const configured = profile.groups.publisherNews[source.id];
      const st = status?.sources[source.id];
      return { id: source.id, name: source.name, selected: selected.some(s => s.id === source.id), state: source.route === 'LICENSED_INTERFACE_REQUIRED' ? 'LICENSED_INTERFACE_REQUIRED' : st?.state ?? 'DISABLED', admitted: st?.counters.admitted ?? 0, polls: st?.counters.polls ?? 0, lastReceiptTs: st?.lastReceiptTs ?? null, reason: source.prerequisite ?? st?.lastError ?? (configured?.desiredState !== 'ON' ? configured?.reason ?? 'profile OFF' : null) };
    });
    const report = { mode: watch ? 'NEWS_ONLY_WATCH' : 'NEWS_ONLY_ONCE', checkedAt: new Date(clock()).toISOString(), dataDir: path.resolve(dataDir), authority: 'NONE', paperStarted: false, paidApiCalls: 0, rows };
    log(JSON.stringify(report, null, 2));
    if (!watch) handle?.stop();
    return { report, stop: () => handle?.stop() };
  } catch (err) { handle?.stop(); throw err; }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => !['--once', '--watch'].includes(arg))) {
    console.error('Usage: node tools/news-setup.mjs [--once|--watch]');
    process.exitCode = 2;
  } else {
    try {
      const { report } = await setupNews({ watch: args.includes('--watch') });
      if (!args.includes('--watch') && (!report.rows.some(r => r.selected) || report.rows.some(r => r.selected && !['OBSERVED', 'NOT_MODIFIED', 'EMPTY_FEED'].includes(r.state)))) process.exitCode = 1;
    } catch (err) { console.error(`News setup could not start: ${err.message}`); process.exitCode = 1; }
  }
}
