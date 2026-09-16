// PUBLISH-FIX-7 — paper account initialization at boot, under owner intent expressed through the deployment environment.
//
// Replit gives the deployment its OWN production PostgreSQL, separate from the workspace's development database, and no
// shell can reach production. So `init-paper` run in the workspace lands in development (ACCOUNT_EXISTS there) while the
// production PAPER boot finds its account uninitialized and the Judge refuses to start (ACCOUNT_UNINITIALIZED). This seam
// lets the production boot itself run the EXACT init-paper path — once, under owner intent — only when the owner has said
// so through the environment: SERPENT_PAPER_INIT_ACCOUNT names the account and SERPENT_CONTROL_PASSWORD is present (only
// the deployment owner sets those). Without the env name, behaviour is unchanged (today's dark refusal). The password is
// never logged or echoed; init refuses to reset an account that already exists.
export const PAPER_BOOT_INIT_LOG = 'PAPER ACCOUNT initialized at boot under owner intent (env)';

// True only when the owner has, through the environment, asked the PAPER boot to initialize its own account.
export function paperBootInitWanted(env) {
  return env.JUDGE_MODE === 'PAPER'
    && typeof env.SERPENT_PAPER_INIT_ACCOUNT === 'string' && env.SERPENT_PAPER_INIT_ACCOUNT.length > 0
    && typeof env.SERPENT_CONTROL_PASSWORD === 'string' && env.SERPENT_CONTROL_PASSWORD.length > 0;
}

// Compose the Judge; if its PAPER account is uninitialized AND the owner asked for a boot init through the environment,
// run the injected init-paper path once (owner intent from env, refuses reset), log, and re-compose. Any other compose
// failure — or the env conditions unmet — propagates unchanged, so a missing env name keeps today's dark refusal and a
// wrong password (owner intent refused inside initPaper) fails closed exactly as the CLI does.
//   compose():   () => Promise<judgeRun>   — may throw a JournalError with code ACCOUNT_UNINITIALIZED
//   initPaper(): () => Promise<void>       — the exact init-paper command path under owner intent (never logs the password)
export async function composePaperJudgeWithBootInit({ env, compose, initPaper, log = () => {} }) {
  try {
    return await compose();
  } catch (err) {
    if (err?.code !== 'ACCOUNT_UNINITIALIZED' || !paperBootInitWanted(env)) throw err;
    await initPaper();       // owner intent from env; refuses reset if the account exists
    log(PAPER_BOOT_INIT_LOG); // the password is never part of this line
    return await compose();  // the account now exists in the production database; compose the Judge
  }
}
