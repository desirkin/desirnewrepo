// The child-process body of the I/O probe: it exercises the REAL production commands and readers under the seam in
// test/helpers/fs-probe.cjs, then prints one JSON line of results. Invoked only by the SOCIAL-5B completion tests.
import path from 'node:path';
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { journalFixture, writeChildhoodArchive, linearBars, T0, SEC } from './social-5b.js';
import { runSnapshot, runBuild, runEvaluate, readSnapshotDir, readDatasetDir, readEvaluationDir } from '../../research/pipeline.js';
import { readChildhoodArchive } from '../../research/archive.js';
import { prepareOutputTarget, reserveOutputDir, jsonlWriter, writeJsonFile } from '../../research/artifacts.js';

const ASOF = T0 + 86_400_000; const SPLIT = T0 + 5 * 3_600_000; const CREATED = T0 + 6 * 3_600_000;
const out = { ok: false, error: null, sealed: null, code: null };
const W = mkdtempSync(path.join(tmpdir(), 'cobra-probe-'));
try {
  const mode = process.argv[2];
  if (mode === 'read') {
    const fx = await journalFixture({ coins: ['ZQQ7'], shadow: false });
    const arch = path.join(W, 'arch');
    writeChildhoodArchive(arch, { series: [{ symbol: 'ZQQ7', candles: linearBars({ fromSec: SEC(T0) - 600, toSec: SEC(T0) + 18_000 }) }], archiveCreatedTs: new Date(CREATED).toISOString(), retrievedSec: SPLIT / 1000, tracks: { '5m': [{ symbol: 'ZQQ7', intervalMin: 5, retrievedTs: new Date(SPLIT).toISOString(), retrievedSec: SPLIT / 1000, candles: linearBars({ fromSec: SEC(T0) - 600, toSec: SEC(T0) + 18_000 }).filter((c) => c[0] % 300 === 0) }], '15m': null, '60m': null } });
    const snap = await runSnapshot({ events: fx.events, out: path.join(W, 'snap') });
    const ds = await runBuild({ snapshotDir: snap.dir, childhoodDir: arch, asOfTs: ASOF, out: path.join(W, 'ds') });
    const ev = await runEvaluate({ datasetDir: ds.dir, splitAtTs: SPLIT, out: path.join(W, 'ev') });
    (await import('node:fs')).appendFileSync(process.env.COBRA_FS_PROBE_LOG, '--- REOPEN ---\n');
    readSnapshotDir(snap.dir); readDatasetDir(ds.dir); readEvaluationDir(ev.dir); readChildhoodArchive(arch);
    out.ok = true;
  } else if (mode === 'write') {
    // a failure injected into the writer must leave NO completed output and NO seal
    const res = reserveOutputDir(prepareOutputTarget(path.join(W, 'w')));
    try {
      const jw = jsonlWriter(res, 'rows.jsonl');
      for (let i = 0; i < 4; i += 1) jw.write({ i, pad: 'x'.repeat(400) });
      const o = jw.close();
      writeJsonFile(res, 'm.json', { outputs: { 'rows.jsonl': o } });
      out.ok = true; out.sealed = existsSync(path.join(res.dir, 'm.json'));
      out.digestMatches = o.sha256 === (await import('node:crypto')).createHash('sha256').update((await import('node:fs')).readFileSync(path.join(res.dir, 'rows.jsonl'))).digest('hex');
    } catch (e) { out.code = e.code ?? null; out.error = String(e.message).slice(0, 120); out.sealed = existsSync(path.join(res.dir, 'm.json')); out.leftovers = existsSync(res.dir) ? readdirSync(res.dir) : []; }
  }
} catch (e) { out.error = String(e.message).slice(0, 200); out.code = e.code ?? null; }
process.stdout.write('RESULT ' + JSON.stringify(out) + '\n');
