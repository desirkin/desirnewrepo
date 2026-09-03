// Staged promotion (B-0B §16). The authoritative archive is untouched while
// a replacement builds in staging; only a VALIDATED staging may take its
// place; a failed promotion rolls back; generations are never merged.
import { existsSync, renameSync } from 'node:fs';
import { validateChildhood } from './validate.js';

export function promoteStaging(stagingDir, authoritativeDir, { validate = validateChildhood, now = Date.now } = {}) {
  const validation = validate(stagingDir);
  if (!validation.ok) {
    // fail closed: authoritative untouched, staging retained for inspection
    return { promoted: false, stage: 'validation', errors: validation.errors, stagingRetainedAt: stagingDir };
  }
  let supersededPath = null;
  if (existsSync(authoritativeDir)) {
    supersededPath = `${authoritativeDir}-superseded-${now()}`;
    renameSync(authoritativeDir, supersededPath);
  }
  try {
    renameSync(stagingDir, authoritativeDir);
  } catch (err) {
    // promotion failed after displacing the old archive: roll back
    if (supersededPath && existsSync(supersededPath) && !existsSync(authoritativeDir)) {
      renameSync(supersededPath, authoritativeDir);
      return { promoted: false, stage: 'promotion', errors: [err.message], rolledBack: true };
    }
    return { promoted: false, stage: 'promotion', errors: [err.message], rolledBack: false };
  }
  return { promoted: true, supersededPath, validation: validation.stats };
}
