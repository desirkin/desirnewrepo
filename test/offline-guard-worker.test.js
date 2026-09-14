// Test-only Worker propagation for the offline guard. Intentional denials run
// in an isolated process and use a selftest log, never the ordinary-suite log.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const execFileP = promisify(execFile);
const GUARD_URL = pathToFileURL(path.resolve('test/helpers/offline-guard.mjs')).href;

test('a guarded real ESM Worker keeps env empty and its nested child uses the exact isolated evidence log', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cobra-worker-guard-selftest-'));
  const log = path.join(root, 'worker.jsonl');
  const scriptFile = path.join(root, 'parent.mjs');
  const run = `selftest:worker-empty-env:${randomUUID().slice(0, 8)}`;
  const workerScript = `
    import { parentPort } from 'node:worker_threads';
    import { execFile } from 'node:child_process';
    import { promisify } from 'node:util';
    const envKeys = Object.keys(process.env).sort();
    let direct;
    try { await fetch('https://worker-guard.invalid/direct'); direct = 'OPENED'; }
    catch (error) { direct = error.cause?.code ?? error.code ?? error.message; }
    const nested = await promisify(execFile)(process.execPath, ['-e',
      "fetch('https://nested-worker-guard.invalid/child').then(() => console.log('OPENED'), (error) => console.log(error.cause?.code ?? error.code ?? error.message))"
    ], { env: {} });
    parentPort.postMessage({ envKeys, direct, nested: nested.stdout.trim(), pid: process.pid });`;
  writeFileSync(scriptFile, `
    import { Worker } from 'node:worker_threads';
    const source = ${JSON.stringify(workerScript)};
    const worker = new Worker(new URL('data:text/javascript;charset=utf-8,' + encodeURIComponent(source)), {
      env: {}, execArgv: ['--import', ${JSON.stringify(GUARD_URL)}],
    });
    const result = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    await worker.terminate();
    console.log(JSON.stringify(result));`);
  try {
    const result = await execFileP(process.execPath, [scriptFile], {
      env: {
        PATH: process.env.PATH,
        NODE_OPTIONS: `--import=${JSON.stringify(GUARD_URL)}`,
        COBRA_OFFLINE_GUARD_LOG: log,
        COBRA_OFFLINE_GUARD_RUN: run,
      },
      timeout: 30_000,
    });
    const out = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.deepEqual(out.envKeys, [], 'the guard must not repopulate the product Worker environment');
    assert.equal(out.direct, 'OFFLINE_GUARD_DENIED');
    assert.equal(out.nested, 'OFFLINE_GUARD_DENIED', 'the nested child retains the guard');
    assert.equal(existsSync(log), true, 'both denials use the designated isolated log');
    const records = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(records.map(({ kind, host, port }) => ({ kind, host, port })), [
      { kind: 'FETCH', host: 'worker-guard.invalid', port: 443 },
      { kind: 'FETCH', host: 'nested-worker-guard.invalid', port: 443 },
    ]);
    assert.equal(records[0].pid, out.pid);
    assert.notEqual(records[1].pid, out.pid);
    for (const record of records) assert.equal(record.run, run);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
