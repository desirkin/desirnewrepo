// JUDGE — local authenticated owner intent for the CLI door (ticket §9.1): every mutating command proves the owner's
// intent with the SAME configured control password the cockpit uses (ui/auth.js ControlAuth: limiter, digest compare,
// never logged), supplied ONLY through stdin or a named environment variable — never a CLI positional / flag value,
// never a file, never an editable JSON boolean. Each authorized intent is appended to a durable audit file with a
// non-reversible session tag, the action, the binding and the revision it targeted. Durable owner records (release
// approvals, arm challenges) live under <data dir>/execution and are validated on every read with the shared validators.
import { mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendJsonl, atomicWriteJson } from '../lib/jsonl.js';
import { dataDir } from '../lib/config.js';
import { ControlAuth } from '../ui/auth.js';
import { manifestError, createArmChallenge, verifyArmRequest } from './arming.js';
import { digestOf, shapeError, T } from '../execution/contract.js';

export const OWNER_PASSWORD_ENV = 'JUDGE_OWNER_PASSWORD'; // the SUPPLIED password (verified against SERPENT_CONTROL_PASSWORD)
export const executionDir = () => path.join(dataDir(), 'execution');
export const ownerAuditFile = () => path.join(executionDir(), 'owner_audit.jsonl');
export const approvalsDir = () => path.join(executionDir(), 'approvals');
export const challengeFile = () => path.join(executionDir(), 'arm-challenge.json');
const APPROVAL_SCHEMA = Object.freeze({ approvalVersion: T.en(['judge-release-approval-1']), approvalId: T.id, manifestDigest: T.hex64, releaseDigest: T.hex64, codeTreeDigest: T.hex64, policyDigest: T.hex64, ownerRef: T.id, sessionTag: T.id, approvedTs: T.ts, assessmentDigest: T.hex64, assessment: T.text, grants: T.en(['ELIGIBILITY_FOR_PREFLIGHT_CANARY_ARM_CHECKS_ONLY']), calibrationState: T.en(['UNVALIDATED_HYPOTHESIS']) });

// read the supplied password: stdin (--owner-stdin true, first line) or the named environment variable; never argv
export async function readSuppliedPassword({ env, stdin = null, useStdin = false }) {
  if (useStdin) { if (!stdin) return null; const text = await new Promise((resolve, reject) => { let buf = ''; stdin.setEncoding('utf8'); stdin.on('data', (c) => { buf += c; }); stdin.on('end', () => resolve(buf)); stdin.on('error', reject); }); const line = text.split('\n')[0] ?? ''; return line.length ? line : null; }
  const v = env[OWNER_PASSWORD_ENV]; return typeof v === 'string' && v.length ? v : null;
}
// verify owner intent for one action; the audit line never carries the password, only the outcome, tag and binding
export function verifyOwnerIntent({ supplied, env, action, binding = {}, now = Date.now, audit = ownerAuditFile }) {
  const auth = new ControlAuth({ password: env.SERPENT_CONTROL_PASSWORD ?? '', now }); // the SUPPLIED env only: never the ambient process environment
  if (!auth.configured()) return { ok: false, reason: 'CONTROL_AUTH_UNCONFIGURED' };
  if (supplied === null || supplied === undefined) return { ok: false, reason: 'OWNER_PASSWORD_REQUIRED' };
  const r = auth.login(supplied); const line = { ts: new Date(now()).toISOString(), door: 'cli', action, ok: r.authenticated, reason: r.authenticated ? null : r.reason, sessionTag: r.authenticated ? r.sessionId.slice(0, 8) : null, binding };
  try { mkdirSync(path.dirname(audit()), { recursive: true }); appendJsonl(audit(), line); } catch { /* audit best effort; the decision stands */ }
  if (!r.authenticated) return { ok: false, reason: r.reason };
  return { ok: true, ownerRef: `owner-${r.sessionId.slice(0, 12)}`, sessionTag: r.sessionId.slice(0, 8) };
}
// the exact tracked tree digest of the running code (git object id of HEAD's tree); null when unknown -> never a proof
export function codeTreeDigest({ cwd = process.cwd() } = {}) { try { const t = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); return /^[0-9a-f]{40}$/.test(t) ? `${t}${'0'.repeat(24)}` : null; } catch { return null; } }
export function writeApproval(approval) { mkdirSync(approvalsDir(), { recursive: true }); const file = path.join(approvalsDir(), `${approval.approvalId}.json`); atomicWriteJson(file, approval, { pretty: true }); return file; }
export function readApproval(file) { const raw = JSON.parse(readFileSync(file, 'utf8')); const e = shapeError(raw, APPROVAL_SCHEMA, 'approval'); if (e) return { ok: false, reason: 'APPROVAL_INVALID', detail: e }; if (digestOf(raw.assessment) !== raw.assessmentDigest) return { ok: false, reason: 'APPROVAL_ASSESSMENT_TAMPERED' }; return { ok: true, approval: raw }; }
export function listApprovals() { try { return readdirSync(approvalsDir()).filter((f) => f.endsWith('.json')).sort(); } catch { return []; } }
export function readManifest(file) { const raw = JSON.parse(readFileSync(file, 'utf8')); const e = manifestError(raw); return e ? { ok: false, reason: 'MANIFEST_INVALID', detail: e } : { ok: true, manifest: raw }; }
// arm challenge: server-generated, bound, short-lived, durable so the confirm step can be a separate invocation
export function issueChallenge({ accountId, allocationCeiling, policyDigest, releaseDigest, nowTs }) { const c = createArmChallenge({ accountId, allocationCeiling, policyDigest, releaseDigest, nowTs }); mkdirSync(executionDir(), { recursive: true }); atomicWriteJson(challengeFile(), c, { pretty: true }); return c; }
export function consumeChallenge({ request, nowTs }) { if (!existsSync(challengeFile())) return { ok: false, reason: 'NO_CHALLENGE' }; const c = JSON.parse(readFileSync(challengeFile(), 'utf8')); const v = verifyArmRequest({ challenge: c, request, nowTs }); try { atomicWriteJson(challengeFile(), { consumedTs: nowTs, challengeId: c.challengeId }, { pretty: true }); } catch { /* a stale challenge file is refused by expiry anyway */ } return v.ok ? { ok: true, challenge: c } : v; }
