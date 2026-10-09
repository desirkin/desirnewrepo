// The Socrates page (owner, 2026-10-09): read-only, GET only, reads the trader's own files and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function startUi(dataDir) {
  const child = spawn(process.execPath, ['ui/server.js'], { env: { ...process.env, COBRA_DATA_DIR: dataDir, PORT: '0', SERPENT_DATA_GENERATION: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => { let buf = ''; const onData = (d) => { buf += d.toString(); const m = buf.match(/http:\/\/localhost:(\d+)/); if (m) resolve(Number(m[1])); }; child.stdout.on('data', onData); child.stderr.on('data', onData); child.on('exit', (c) => reject(new Error(`ui exited ${c}: ${buf.slice(0, 400)}`))); setTimeout(() => reject(new Error(`no port: ${buf.slice(0, 400)}`)), 15000); });
  return { port, stop: () => child.kill('SIGTERM') };
}

test('UI-SOC-1. /socrates serves the page, /api/socrates serves status + trades + looks from the trader files; POST is refused; missing files give an honest empty', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-soc-')); const tdir = path.join(dir, 'socrates-trader'); mkdirSync(tdir, { recursive: true });
  writeFileSync(path.join(tdir, 'status.json'), JSON.stringify({ version: 'socrates-trader-3', asOfTs: 1, equityUsd: 504.2, returnPct: 0.84, cashUsd: 0, trades: 1, wins: 1, cage: { won: 1, lost: 0, neutral: 0, caged: false }, positions: { OGN: { qty: 1000, entryPx: 0.5, entryTs: 1, costUsd: 500, entryFeeUsd: 2, stop: 0.47, why: 'fresh money' } }, orders: {}, spend: { todayUsd: 1.2, capPerDayUsd: 15 } }));
  writeFileSync(path.join(tdir, 'trades.jsonl'), [
    JSON.stringify({ ts: 1, kind: 'START' }),
    JSON.stringify({ ts: 2, kind: 'SCAN', pocket: ['OGN'], note: 'OGN looks fresh', results: [{ type: 'BUY', coin: 'OGN' }] }),
    JSON.stringify({ ts: 3, kind: 'SELL', coin: 'CTSI', entryPx: 0.03, exitPx: 0.0312, pnlUsd: 18.2, pnlPct: 3.6, heldMin: 22, reason: 'TARGET', part: 'ALL', why: '+4% reached' }),
    JSON.stringify({ ts: 4, kind: 'WINDOW', n: 1, verdict: 'WON' }),
    'not json at all',
  ].join('\n') + '\n');
  const ui = await startUi(dir);
  try {
    const page = await fetch(`http://localhost:${ui.port}/socrates`); assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/); const html = await page.text(); assert.ok(html.includes('<title>Socrates</title>')); assert.ok(html.includes('/api/socrates')); assert.ok(!html.includes('<form'), 'no form, nothing to submit');
    const r = await fetch(`http://localhost:${ui.port}/api/socrates`); assert.equal(r.status, 200); const j = await r.json();
    assert.equal(j.status.equityUsd, 504.2); assert.equal(j.sells.length, 1); assert.equal(j.sells[0].reason, 'TARGET'); assert.equal(j.decisions.length, 1); assert.equal(j.decisions[0].note, 'OGN looks fresh'); assert.equal(j.windows.length, 1); assert.deepEqual(Object.keys(j.status.positions), ['OGN']);
    const post = await fetch(`http://localhost:${ui.port}/api/socrates`, { method: 'POST', body: '{}' }); assert.equal(post.status, 405);
    rmSync(tdir, { recursive: true, force: true });
    const empty = await (await fetch(`http://localhost:${ui.port}/api/socrates`)).json(); assert.equal(empty.status, null); assert.deepEqual(empty.sells, []); assert.deepEqual(empty.decisions, []);
  } finally { ui.stop(); rmSync(dir, { recursive: true, force: true }); }
});
