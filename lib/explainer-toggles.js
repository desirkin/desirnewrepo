// TALK-TO-THEM (2026-09-15) — the durable, protected ASK / SOCRATES toggles and their today's-spend meters. David's
// amendment: the two daily USD caps are CEILINGS; the day-to-day on/off is two protected toggles on the serpent page, each
// with a today's-spend meter, persisted in durable state that survives restart AND republish, default ON for ASK and OFF
// for SOCRATES, and flippable without a publish or a secret edit.
//
// This store is deliberately DECOUPLED from the safety control latches (state/control-store.js kill/cage/veto): a benign
// explainer toggle must never touch — or be able to corrupt — the fail-closed permission state. It lives in its own atomic
// file under <data>/control/, restart-durable; that directory is a backed object-store source (persistence/object-uploader.js)
// so a Replit republish restores it. When the object store is unset the toggles simply fall back to their safe defaults
// after a republish (ASK on, SOCRATES off) — fail-closed, never a fabricated state. Authority NONE; this changes no
// trading permission, only whether the read-only explainer / Socrates may spend.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { atomicWriteJson } from './jsonl.js';

export const EXPLAINER_TOGGLES_VERSION = 'serpent-explainer-toggles-1';
export const EXPLAINER_TOGGLE_DEFAULTS = Object.freeze({ ask: true, socrates: false });
export const EXPLAINER_CAP_ENV = Object.freeze({ key: 'ANTHROPIC_API_KEY', talkDailyUsd: 'SERPENT_TALK_DAILY_USD', socratesDailyUsd: 'SERPENT_SOCRATES_DAILY_USD' });
export const DEFAULT_TALK_DAILY_USD = 2;
export const DEFAULT_SOCRATES_DAILY_USD = 5;
export const EXPLAINER_DORMANT_REASONS = Object.freeze(['CREDENTIAL_MISSING', 'CAP_DISABLED', 'TOGGLE_OFF', 'CAP_REACHED']);

export const explainerTogglesFile = (dataDir) => path.join(dataDir, 'control', 'explainer-toggles.json');
const asBool = (v) => (typeof v === 'boolean' ? v : null);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Read the durable toggles; anything absent, malformed or partial falls back to the safe defaults (never throws, never a
// fabricated on-state for SOCRATES). source says whether the value came from the durable file or the defaults.
export function readExplainerToggles({ dataDir } = {}) {
  try {
    const j = JSON.parse(readFileSync(explainerTogglesFile(dataDir), 'utf8'));
    if (!j || j.version !== EXPLAINER_TOGGLES_VERSION || typeof j !== 'object') return { ...EXPLAINER_TOGGLE_DEFAULTS, updatedTs: null, source: 'DEFAULT' };
    return { ask: asBool(j.ask) ?? EXPLAINER_TOGGLE_DEFAULTS.ask, socrates: asBool(j.socrates) ?? EXPLAINER_TOGGLE_DEFAULTS.socrates, updatedTs: Number.isSafeInteger(j.updatedTs) ? j.updatedTs : null, source: 'FILE' };
  } catch { return { ...EXPLAINER_TOGGLE_DEFAULTS, updatedTs: null, source: 'DEFAULT' }; }
}

// Flip one or both toggles. The patch may carry ONLY `ask` and/or `socrates` booleans — nothing else is read (a toggle
// flip can never smuggle another field into the control directory). Atomic write; returns the new durable state.
export function setExplainerToggles({ dataDir, patch, now = () => Date.now() } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('explainer toggle patch must be an object');
  const keys = Object.keys(patch);
  if (!keys.length || keys.some((k) => k !== 'ask' && k !== 'socrates')) throw new Error('explainer toggle patch may set only ask / socrates');
  for (const k of keys) if (typeof patch[k] !== 'boolean') throw new Error(`explainer toggle ${k} must be a boolean`);
  const current = readExplainerToggles({ dataDir });
  const next = { version: EXPLAINER_TOGGLES_VERSION, ask: patch.ask ?? current.ask, socrates: patch.socrates ?? current.socrates, updatedTs: now() };
  atomicWriteJson(explainerTogglesFile(dataDir), next, { sync: true });
  return { ask: next.ask, socrates: next.socrates, updatedTs: next.updatedTs, source: 'FILE' };
}

// Resolve one daily cap, FAIL-CLOSED: unset / empty / malformed / 0 / negative all resolve to 0 (that half is dormant),
// exactly as the spec says ("0 or unset = that half dormant, fail-closed"). A cap is a ceiling you must set on purpose;
// the documented recommended values (2 / 5) are what the operator sets, never an auto-enable. The env is read by NAME only.
export function resolveDailyCap(env, name) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

// The two meters: combine the durable toggle, the resolved cap, the key presence and today's spend into a plain,
// value-free readout. `half` is 'ask' or 'socrates'; `spentUsdToday` is the durable spend the caller read for that half.
export function explainerMeter({ half, on, keyPresent, capUsd, spentUsdToday }) {
  const spent = finite(spentUsdToday) && spentUsdToday >= 0 ? spentUsdToday : 0;
  let dormant = false; let reason = null;
  if (!keyPresent) { dormant = true; reason = 'CREDENTIAL_MISSING'; }
  else if (!(capUsd > 0)) { dormant = true; reason = 'CAP_DISABLED'; }
  else if (!on) { dormant = true; reason = 'TOGGLE_OFF'; }
  else if (spent >= capUsd) { dormant = true; reason = 'CAP_REACHED'; }
  return Object.freeze({ half, on: on === true, dormant, reason, capUsd: capUsd > 0 ? Number(capUsd) : 0, spentUsdToday: Math.round(spent * 1e6) / 1e6, remainingUsd: capUsd > 0 ? Math.max(0, Math.round((capUsd - spent) * 1e6) / 1e6) : 0 });
}

// The whole readout the cockpit shows beside the control latches: both toggles, both caps (by NAME + resolved value),
// both meters. `spend` supplies today's spent USD per half (from the durable companion ledger / Socrates journal).
export function explainerControlsView({ dataDir, env = process.env, spend = {} } = {}) {
  const toggles = readExplainerToggles({ dataDir });
  const keyPresent = typeof env[EXPLAINER_CAP_ENV.key] === 'string' && env[EXPLAINER_CAP_ENV.key].length > 0;
  const talkCap = resolveDailyCap(env, EXPLAINER_CAP_ENV.talkDailyUsd);
  const socratesCap = resolveDailyCap(env, EXPLAINER_CAP_ENV.socratesDailyUsd);
  return Object.freeze({
    version: EXPLAINER_TOGGLES_VERSION,
    credentialName: EXPLAINER_CAP_ENV.key, credentialPresent: keyPresent,
    ask: explainerMeter({ half: 'ask', on: toggles.ask, keyPresent, capUsd: talkCap, spentUsdToday: spend.talkUsd }),
    socrates: explainerMeter({ half: 'socrates', on: toggles.socrates, keyPresent, capUsd: socratesCap, spentUsdToday: spend.socratesUsd }),
    caps: { talk: { name: EXPLAINER_CAP_ENV.talkDailyUsd, usd: talkCap, recommendedUsd: DEFAULT_TALK_DAILY_USD }, socrates: { name: EXPLAINER_CAP_ENV.socratesDailyUsd, usd: socratesCap, recommendedUsd: DEFAULT_SOCRATES_DAILY_USD } },
    updatedTs: toggles.updatedTs, togglesSource: toggles.source, authority: 'NONE',
    law: 'the caps are ceilings; the toggles are the day-to-day on/off; flipping needs no publish or secret edit; this changes no trading permission',
  });
}
