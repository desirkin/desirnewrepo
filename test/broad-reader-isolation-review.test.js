import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BROAD_URL = new URL('../market-lab/broad-kraken.js', import.meta.url).href;

test('importing the broad-market reader cannot write or start network acquisition', () => {
  const permissionFlag = process.allowedNodeEnvironmentFlags.has('--permission')
    ? '--permission'
    : process.allowedNodeEnvironmentFlags.has('--experimental-permission')
      ? '--experimental-permission'
      : null;
  assert.ok(permissionFlag, 'the supported Node runtime must expose its filesystem permission fence');

  const source = `
    let fetchCalls = 0;
    let socketConstructs = 0;
    globalThis.fetch = () => { fetchCalls += 1; throw new Error('network forbidden during import'); };
    globalThis.WebSocket = class ForbiddenWebSocket {
      constructor() { socketConstructs += 1; throw new Error('socket forbidden during import'); }
    };
    const mod = await import(${JSON.stringify(BROAD_URL)});
    if (typeof mod.readBroadKrakenLatest !== 'function') throw new Error('reader export absent');
    if (fetchCalls !== 0 || socketConstructs !== 0) throw new Error('import started network acquisition');
  `;
  const child = spawnSync(process.execPath, [
    permissionFlag,
    `--allow-fs-read=${REPO}`,
    '--input-type=module',
    '--eval',
    source,
  ], { cwd: REPO, encoding: 'utf8', timeout: 10_000 });

  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, `isolated import failed:\n${child.stderr || child.stdout}`);
});
