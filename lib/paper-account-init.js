// lib/paper-account-init.js — PUBLISH-FIX-7 (2026-09-16): paper account initialization at boot under owner intent.
//
// Replit gives the published app its own PRODUCTION PostgreSQL, separate from the workspace's development database, and
// no shell can reach production. So `init-paper` run from the workspace lands in the wrong database and the deployed
// Judge refuses to start (ACCOUNT_UNINITIALIZED). The owner expresses intent through the environment instead:
//   SERPENT_PAPER_INIT_ACCOUNT = the account the policy names (e.g. paper-reference-usd500)
//   SERPENT_CONTROL_PASSWORD   = the owner password (already the control-auth secret)
// With both present and JUDGE_MODE=PAPER, the paper boot runs the EXACT `init-paper` command path (same policy, same
// owner-intent verification, same audit line, refuses to reset an existing account) before composing the Judge.
// Without the account name the boot is unchanged. The password is never logged, never echoed, never a flag.
import { readFileSync } from 'node:fs';

export const PAPER_INIT_ACCOUNT_ENV = 'SERPENT_PAPER_INIT_ACCOUNT';

export async function initPaperAccountAtBoot({
  env = process.env,
  log = () => {},
  loadCommands = async () => {
    const [{ createCommands }, { OWNER_PASSWORD_ENV }] = await Promise.all([import('../judge/commands.js'), import('../judge/owner.js')]);
    return { createCommands, OWNER_PASSWORD_ENV };
  },
  readPolicy = (file) => JSON.parse(readFileSync(file, 'utf8')),
} = {}) {
  const wanted = typeof env[PAPER_INIT_ACCOUNT_ENV] === 'string' ? env[PAPER_INIT_ACCOUNT_ENV].trim() : '';
  if (!wanted) return { outcome: 'SKIPPED', reason: `${PAPER_INIT_ACCOUNT_ENV} unset` };
  if (env.JUDGE_MODE !== 'PAPER') return { outcome: 'SKIPPED', reason: `JUDGE_MODE ${env.JUDGE_MODE ?? 'unset'} is not PAPER` };
  if (!env.JUDGE_POLICY) { log('PAPER ACCOUNT init at boot refused: JUDGE_POLICY unset'); return { outcome: 'REFUSED', reason: 'JUDGE_POLICY unset' }; }
  if (typeof env.SERPENT_CONTROL_PASSWORD !== 'string' || !env.SERPENT_CONTROL_PASSWORD.length) {
    log('PAPER ACCOUNT init at boot refused: SERPENT_CONTROL_PASSWORD absent (owner intent needs the control password)');
    return { outcome: 'REFUSED', reason: 'SERPENT_CONTROL_PASSWORD absent' };
  }
  let policyAccount = null;
  try { policyAccount = readPolicy(env.JUDGE_POLICY)?.account?.accountId ?? null; }
  catch (err) { log(`PAPER ACCOUNT init at boot refused: policy unreadable (${err?.code ?? err?.message ?? err})`); return { outcome: 'REFUSED', reason: 'policy unreadable' }; }
  if (policyAccount !== wanted) {
    log(`PAPER ACCOUNT init at boot refused: ${PAPER_INIT_ACCOUNT_ENV} names ${wanted} but the policy names ${policyAccount ?? 'no account'}`);
    return { outcome: 'REFUSED', reason: 'account name does not match the policy' };
  }
  const { createCommands, OWNER_PASSWORD_ENV } = await loadCommands();
  // the SUPPLIED password rides in the command env only (verified against SERPENT_CONTROL_PASSWORD by owner intent)
  const commandEnv = { ...env, [OWNER_PASSWORD_ENV]: env.SERPENT_CONTROL_PASSWORD };
  const cmds = createCommands({ env: commandEnv, log: () => {} });
  try {
    const r = await cmds['init-paper']({ policy: env.JUDGE_POLICY });
    log(`PAPER ACCOUNT initialized at boot under owner intent (env): ${r.accountId} revision ${r.revision} capital ${r.initialCapital} mode ${r.mode}`);
    return { outcome: 'INITIALIZED', accountId: r.accountId, revision: r.revision };
  } catch (err) {
    const code = err?.code ?? err?.constructor?.name ?? 'UNKNOWN';
    if (code === 'ACCOUNT_EXISTS') { log(`PAPER ACCOUNT already initialized (${wanted}); no reset`); return { outcome: 'EXISTS', accountId: wanted }; }
    log(`PAPER ACCOUNT init at boot failed: ${code}`);
    return { outcome: 'FAILED', reason: code };
  }
}
