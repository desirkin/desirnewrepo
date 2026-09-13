// The perpetual service must publish its control/status surface after catalogs resolve, without waiting for a potentially
// slow all-provider REST sweep. Bounded captures keep the opposite default: their declared duration begins after bootstrap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createResearchOwner } from '../market-lab/owner.js';
import { createResearchService } from '../market-lab/service.js';
import { loadPolicy, loadSubjects, samplePolicy, sampleSubjects } from '../market-lab/policy.js';
import * as H from './helpers/market-lab.js';

const T0 = Date.parse('2026-09-08T12:00:00Z');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'mlab-bootstrap-'));
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function fredPolicy() { const p = structuredClone(samplePolicy()); p.providers.FRED.enabled = true; return loadPolicy(p); }
function fredSubjects() { const s = structuredClone(sampleSubjects()); s.subjects = [s.subjects[0]]; s.macroSeries = ['CPIAUCSL']; s.crossAsset = []; return loadSubjects(s); }
function controlledTimers() {
  const intervals = [];
  return {
    intervals,
    setInterval(fn, ms) { const h = { fn, ms, cleared: false, unref() {} }; intervals.push(h); return h; },
    clearInterval(h) { if (h) h.cleared = true; },
    setTimeout(fn, ms) { return setTimeout(fn, ms); },
    clearTimeout(h) { clearTimeout(h); },
  };
}
function hangingFetch() {
  const state = { calls: 0, active: 0, maxActive: 0 };
  const fetchImpl = (_url, { signal } = {}) => {
    state.calls += 1; state.active += 1; state.maxActive = Math.max(state.maxActive, state.active);
    return new Promise((_resolve, reject) => {
      let done = false;
      const abort = () => { if (done) return; done = true; state.active -= 1; reject(signal?.reason ?? new Error('aborted')); };
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
  };
  return { state, fetchImpl };
}
async function within(promise, ms = 1000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); })]); }
  finally { clearTimeout(timer); }
}

test('service starts around a slow initial sweep, exposes bootstrap state, suppresses overlapping periodic sweeps, stops the sweep, and a new service can restart on the same root', async () => {
  const root = tmp(); const timers = controlledTimers(); const slow = hangingFetch();
  const service = createResearchService({ policy: fredPolicy(), subjects: fredSubjects(), env: { FRED_API_KEY: 'FREDKEY' }, researchRoot: root, mode: 'INTEGRATED', clock: () => T0, fetchImpl: slow.fetchImpl, timers, httpPort: null, families: ['MACRO_RELEASES'], closeDrainMs: 1000, log: () => {} });
  try {
    const started = await within(service.start());
    assert.equal(started.state, 'ACTIVE');
    await H.waitFor(() => slow.state.calls === 1);
    assert.deepEqual({ state: service.status().bootstrap.initialState, mode: service.status().bootstrap.initialMode, running: service.status().bootstrap.running }, { state: 'RUNNING', mode: 'BACKGROUND', running: true });

    const sweepTimer = timers.intervals.find((h) => h.ms === 300_000); assert.ok(sweepTimer, 'perpetual service schedules the provider sweep');
    sweepTimer.fn(); sweepTimer.fn(); await Promise.resolve();
    assert.equal(slow.state.calls, 1, 'periodic ticks join/skip the active sweep instead of dispatching an overlap');
    assert.equal(slow.state.maxActive, 1);
    assert.equal(service.status().bootstrap.overlapSkips, 2);

    const stopped = await within(service.stop({ seal: false }));
    assert.equal(stopped.state, 'STOPPED'); assert.equal(slow.state.active, 0);
    assert.equal(service.status().bootstrap.initialState, 'STOPPED'); assert.equal(service.status().bootstrap.running, false);
    assert.ok(timers.intervals.every((h) => h.cleared));
    sweepTimer.fn(); await Promise.resolve(); assert.equal(slow.state.calls, 1, 'a cleared late tick has no authority after stop');

    const timers2 = controlledTimers(); let calls2 = 0;
    const fetch2 = async (url) => { calls2 += 1; return new URL(url).pathname === '/fred/series' ? json(H.FRED_SERIES) : json(H.FRED_OBSERVATIONS); };
    const restarted = createResearchService({ policy: fredPolicy(), subjects: fredSubjects(), env: { FRED_API_KEY: 'FREDKEY' }, researchRoot: root, mode: 'INTEGRATED', clock: () => T0 + 1, fetchImpl: fetch2, timers: timers2, httpPort: null, families: ['MACRO_RELEASES'], log: () => {} });
    assert.equal((await within(restarted.start())).state, 'ACTIVE');
    await H.waitFor(() => restarted.status().bootstrap.initialState === 'COMPLETE');
    assert.equal(calls2, 2); assert.equal(restarted.status().bootstrap.initialMode, 'BACKGROUND');
    await restarted.stop({ seal: false });
  } finally {
    if (service.isActive()) await service.stop({ seal: false });
    rmSync(root, { recursive: true, force: true });
  }
});

test('owner keeps awaitInitialSweep=true by default for bounded capture callers', async () => {
  const slow = hangingFetch(); const owner = createResearchOwner({ policy: fredPolicy(), subjects: fredSubjects(), env: { FRED_API_KEY: 'FREDKEY' }, mode: 'INTEGRATED', clock: () => T0, fetchImpl: slow.fetchImpl, closeDrainMs: 1000, log: () => {} });
  let settled = false; const starting = owner.start({ families: ['MACRO_RELEASES'] }).then((v) => { settled = true; return v; });
  await H.waitFor(() => slow.state.calls === 1); await Promise.resolve();
  assert.equal(settled, false); assert.equal(owner.status().bootstrap.initialMode, 'AWAITED');
  await within(owner.stop({ seal: false })); await within(starting);
  assert.equal(owner.status().bootstrap.initialState, 'STOPPED'); assert.equal(owner.status().bootstrap.running, false);
});
