// TALK-TO-THEM (2026-09-15) — the durable ASK / SOCRATES toggles + spend meters. Restart-durable file, safe defaults, the
// caps are ceilings and the toggles are the on/off. No network; the safety control latches are never touched here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readExplainerToggles, setExplainerToggles, resolveDailyCap, explainerMeter, explainerControlsView, explainerTogglesFile, EXPLAINER_CAP_ENV, DEFAULT_TALK_DAILY_USD, DEFAULT_SOCRATES_DAILY_USD } from '../lib/explainer-toggles.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'serpent-tog-'));

test('ET-1. defaults: ASK on, SOCRATES off, no file present (source DEFAULT) — a republish that wiped the file is safe', () => {
  const d = tmp();
  try { const t = readExplainerToggles({ dataDir: d }); assert.deepEqual({ ask: t.ask, socrates: t.socrates, source: t.source }, { ask: true, socrates: false, source: 'DEFAULT' }); assert.equal(existsSync(explainerTogglesFile(d)), false); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('ET-2. flipping persists durably and survives a re-read; the patch may set only ask/socrates booleans', () => {
  const d = tmp();
  try {
    let t = 100; const set = (patch) => setExplainerToggles({ dataDir: d, patch, now: () => (t += 1) });
    const on = set({ socrates: true }); assert.equal(on.socrates, true); assert.equal(on.ask, true, 'unspecified halves keep their value');
    assert.equal(readExplainerToggles({ dataDir: d }).socrates, true, 'the flip is durable across a fresh read');
    const off = set({ ask: false }); assert.equal(off.ask, false); assert.equal(off.socrates, true);
    assert.ok(off.updatedTs > on.updatedTs);
    assert.throws(() => set({}), /only ask/); assert.throws(() => set({ kill: true }), /only ask/); assert.throws(() => set({ ask: 'yes' }), /must be a boolean/); assert.throws(() => setExplainerToggles({ dataDir: d, patch: null }), /object/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('ET-3. resolveDailyCap is fail-closed: unset / empty / malformed / 0 / negative -> 0 (dormant); a valid positive -> its value', () => {
  assert.equal(resolveDailyCap({}, 'X'), 0);
  assert.equal(resolveDailyCap({ X: '' }, 'X'), 0);
  assert.equal(resolveDailyCap({ X: '0' }, 'X'), 0);
  assert.equal(resolveDailyCap({ X: '-3' }, 'X'), 0);
  assert.equal(resolveDailyCap({ X: '3.5' }, 'X'), 3.5);
  assert.equal(resolveDailyCap({ X: 'lots' }, 'X'), 0);
});

test('ET-4. the meter names the dormant reason in precedence order and reports the remaining budget', () => {
  assert.equal(explainerMeter({ half: 'ask', on: true, keyPresent: false, capUsd: 2, spentUsdToday: 0 }).reason, 'CREDENTIAL_MISSING');
  assert.equal(explainerMeter({ half: 'ask', on: true, keyPresent: true, capUsd: 0, spentUsdToday: 0 }).reason, 'CAP_DISABLED');
  assert.equal(explainerMeter({ half: 'socrates', on: false, keyPresent: true, capUsd: 5, spentUsdToday: 0 }).reason, 'TOGGLE_OFF');
  const reached = explainerMeter({ half: 'ask', on: true, keyPresent: true, capUsd: 2, spentUsdToday: 2 }); assert.equal(reached.reason, 'CAP_REACHED'); assert.equal(reached.dormant, true); assert.equal(reached.remainingUsd, 0);
  const live = explainerMeter({ half: 'ask', on: true, keyPresent: true, capUsd: 2, spentUsdToday: 0.5 }); assert.equal(live.dormant, false); assert.equal(live.reason, null); assert.equal(live.remainingUsd, 1.5);
});

test('ET-5. the whole readout: with a key + the caps set, ASK is live and SOCRATES is dormant TOGGLE_OFF by default; an unset cap is dormant CAP_DISABLED; without a key both are CREDENTIAL_MISSING; no secret value appears', () => {
  const d = tmp();
  try {
    const env = { [EXPLAINER_CAP_ENV.key]: 'sk-do-not-log', [EXPLAINER_CAP_ENV.talkDailyUsd]: '2', [EXPLAINER_CAP_ENV.socratesDailyUsd]: '5' };
    const withKey = explainerControlsView({ dataDir: d, env, spend: { talkUsd: 0.25, socratesUsd: 0 } });
    assert.equal(withKey.credentialPresent, true); assert.equal(withKey.ask.dormant, false); assert.equal(withKey.ask.spentUsdToday, 0.25); assert.equal(withKey.ask.remainingUsd, 1.75);
    assert.equal(withKey.socrates.dormant, true); assert.equal(withKey.socrates.reason, 'TOGGLE_OFF');
    assert.equal(withKey.caps.talk.usd, 2); assert.equal(withKey.caps.socrates.usd, 5); assert.equal(withKey.caps.talk.recommendedUsd, DEFAULT_TALK_DAILY_USD); assert.equal(withKey.caps.socrates.recommendedUsd, DEFAULT_SOCRATES_DAILY_USD);
    assert.equal(withKey.caps.talk.name, 'SERPENT_TALK_DAILY_USD'); assert.equal(withKey.caps.socrates.name, 'SERPENT_SOCRATES_DAILY_USD');
    assert.ok(!JSON.stringify(withKey).includes('sk-do-not-log'), 'the credential value never appears in the readout');
    // key present but the talk cap unset -> ASK dormant CAP_DISABLED (a ceiling you must set on purpose; unset = dormant)
    const noCap = explainerControlsView({ dataDir: d, env: { [EXPLAINER_CAP_ENV.key]: 'k' }, spend: {} });
    assert.equal(noCap.ask.reason, 'CAP_DISABLED');
    const noKey = explainerControlsView({ dataDir: d, env: {}, spend: {} });
    assert.equal(noKey.credentialPresent, false); assert.equal(noKey.ask.reason, 'CREDENTIAL_MISSING'); assert.equal(noKey.socrates.reason, 'CREDENTIAL_MISSING');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
