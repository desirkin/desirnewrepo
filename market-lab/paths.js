// MARKET LAB — path law shared by the composition root and the cockpit reader (no other imports): the research root is
// MARKET_RESEARCH_ROOT by environment variable NAME, else <data dir>/market-research. Never a repository path.
import path from 'node:path';
export const marketResearchRootFromEnv = (env, dataDirPath) => (typeof env.MARKET_RESEARCH_ROOT === 'string' && env.MARKET_RESEARCH_ROOT.length ? env.MARKET_RESEARCH_ROOT : path.join(dataDirPath, 'market-research'));
export const CASE_DIR_NAME_RE = /^case-[0-9a-f]{40}-\d{13}$/;
