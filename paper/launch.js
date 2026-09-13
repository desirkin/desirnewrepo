// SERPENT PAPER — the ONE launch entry (`npm run paper` / `node bin/cobra.js paper run`): apply the paper profile to the
// process environment (forced authority names ALWAYS win: JUDGE_MODE=PAPER, JUDGE_ALLOW_PRIVATE/ORDERS=false), start the
// dark research capture runner (segments; authority NONE) a few seconds after the core composition begins, then hand the
// process to fly.js — the existing, proven composition order (persistence bootstrap -> cockpit -> memory mirror -> RUMINT ->
// gateway -> wide eye -> governance -> market research owner + Socrates case runtime -> Judge PAPER (+ Watch, paper
// execution) -> RUMOR2 official + social ears + strainer -> Tape feed loop). fly.js resolves on SIGINT / SIGTERM after the
// Tape's clean shutdown, stops the Judge and the research service, calls the paper shutdown seam (this runner), then exits.
// Nothing here constructs an order path: the paper profile cannot become LIVE.
import path from 'node:path';
import { dataDir as dataDirOf, loadConfig } from '../lib/config.js';
import { marketResearchRootFromEnv, darkResearchRootOf } from '../market-lab/paths.js';
import { loadProfile, applyProfileEnvironment, profileFileOf, PROFILE_ENV, authorityLines } from './profile.js';

export const LAUNCH_VERSION = 'serpent-paper-launch-1';
export const DARK_CAPTURE_START_DELAY_MS = 5_000;
export const COMPOSITION_ORDER = Object.freeze(['persistence bootstrap (restrictive first)', 'cockpit status server', 'memory mirror', 'RUMINT legacy ear', 'gateway (exchange infrastructure)', 'wide eye / universe', 'governance (dark; off)', 'market research owner + Socrates case runtime', 'Judge PAPER (+ Watch + paper execution)', 'RUMOR2 official + social ears + research strainer', 'dark research capture (segments; authority NONE)', 'Tape feed loop (execution feed + research observer seams)']);

export function prepareLaunch({ profileFile = process.env[PROFILE_ENV] ?? 'config/paper-runtime.json', env = process.env, log = console.log } = {}) {
  const profile = loadProfile(profileFile); const applied = applyProfileEnvironment(profile, env);
  if (env.JUDGE_MODE !== 'PAPER' || env.JUDGE_ALLOW_PRIVATE !== 'false' || env.JUDGE_ALLOW_ORDERS !== 'false') throw new Error('paper launch: the forced authority environment did not apply');
  log(`SERPENT PAPER PROFILE ${profile.profileName} (${profile.profileVersion}) — JUDGE_MODE PAPER`); for (const l of authorityLines('PROFILE_APPLIED')) log(`  ${l}`);
  for (const o of applied.overridden) log(`  profile override: ${o.name} was ${o.was} -> ${o.now} (the paper profile forces it)`);
  log(`  enables: ${applied.applied.filter((k) => env[k] === 'true').join(', ')}`);
  log(`  policy ${profile.files.marketResearchPolicy} · subjects ${profile.files.marketResearchSubjects} · judge ${profile.files.judgePolicy}`);
  return { profile, applied };
}
export async function launchPaper({ profileFile, env = process.env, log = console.log, startDark = true, importFly = () => import('../fly.js'), timers = { setTimeout, clearTimeout } } = {}) {
  const { profile } = prepareLaunch({ profileFile, env, log });
  let dark = null; let darkTimer = null;
  if (startDark && profile.groups.darkEdgeCapture.krakenCharts.desiredState !== 'OFF') {
    try {
      const [{ startDarkCapture }, { readPolicyFile, readSubjectsFile }] = await Promise.all([import('./dark-capture.js'), import('../market-lab/commands.js')]);
      const policy = readPolicyFile(profileFileOf(profile, 'marketResearchPolicy')); const subjects = readSubjectsFile(profileFileOf(profile, 'marketResearchSubjects'));
      // the dark runner owns a SIBLING root: the research owner holds its own root's provider quota lock (single-owner law)
      const researchRoot = darkResearchRootOf(marketResearchRootFromEnv(env, dataDirOf(loadConfig())));
      dark = startDarkCapture({ policy, subjects, env, researchRoot, log }); log(`DARK CAPTURE root ${researchRoot} (sibling of the research root; never read by Socrates / Judge / Watch)`);
      darkTimer = timers.setTimeout(() => { darkTimer = null; dark.start(); }, DARK_CAPTURE_START_DELAY_MS);
    } catch (err) { log(`DARK CAPTURE not started (dark; nothing else affected): ${String(err?.message ?? err).slice(0, 160)}`); dark = null; }
  }
  // the shutdown seam fly.js awaits before exiting: every started component stops cleanly (a segment in flight is sealed)
  globalThis.serpentPaperShutdown = async () => { if (darkTimer) { timers.clearTimeout(darkTimer); darkTimer = null; } if (dark) { try { await dark.stop(); } catch (err) { log(`DARK CAPTURE stop failed: ${String(err?.message ?? err).slice(0, 120)}`); } } };
  await importFly();
  return { profile, dark, order: COMPOSITION_ORDER, launchVersion: LAUNCH_VERSION, researchRoot: path.resolve(marketResearchRootFromEnv(env, dataDirOf(loadConfig()))), darkRoot: path.resolve(darkResearchRootOf(marketResearchRootFromEnv(env, dataDirOf(loadConfig())))) };
}
