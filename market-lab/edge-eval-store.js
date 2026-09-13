// MARKET-EDGE closeout — the DURABLE edge-evaluation record store: ONE append-only, digest-chained record file per
// evaluation under <researchRoot>/edge-eval, a memory twin for tests, the SAME semantic validators on append (before the
// row exists) and on read (after the digest chain). Every append serializes under an exclusive lock file and carries a
// revision check (the expected head sequence). createdTs is the RUNTIME clock at append: a caller cannot type an old
// creation time into the chain. Nothing is updated or deleted; the records ARE the truth of the chain.
import { openSync, closeSync, writeSync, fsyncSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { canonicalDigest, deepFreeze, fail, isId, isTs, parseStrictJson } from './contracts.js';
import { EDGE_EVAL_RECORD_KINDS, recordSemanticsError, verifyRecordSemantics, chainStateOf } from './edge-eval-records.js';

export const EDGE_EVAL_STORE_VERSION = 'market-edge-eval-store-1';
export const EDGE_EVAL_DIR = 'edge-eval';
export const MAX_RECORD_BYTES = 4 * 1024 * 1024;
export class EdgeEvalStoreError extends Error { constructor(code, message) { super(`${code}: ${message}`); this.code = code; } }
const rowDigest = ({ evaluationId, seq, kind, record, createdTs, prevDigest }) => canonicalDigest({ v: EDGE_EVAL_STORE_VERSION, evaluationId, seq, kind, record, createdTs, prevDigest });
export function verifyRecordChain(rows) {
  let prev = null; let seq = 0;
  for (const r of rows) { seq += 1; if (r.seq !== seq) return { ok: false, reason: `SEQUENCE_${r.seq}_EXPECTED_${seq}` }; if ((r.prevDigest ?? null) !== prev) return { ok: false, reason: `PREV_DIGEST_${seq}` }; if (!isTs(r.createdTs)) return { ok: false, reason: `CREATED_${seq}` }; if (rowDigest(r) !== r.digest) return { ok: false, reason: `DIGEST_${seq}` }; prev = r.digest; }
  return { ok: true, records: rows.length, headDigest: prev };
}
const checkRead = (evaluationId, rows) => { const v = verifyRecordChain(rows); if (!v.ok) throw new EdgeEvalStoreError('CHAIN_INVALID', `${evaluationId}: ${v.reason}`); const s = verifyRecordSemantics(rows); if (!s.ok) throw new EdgeEvalStoreError('RECORD_INVALID', `${evaluationId}: record ${s.seq}: ${s.reason}`); };
const checkAppend = (evaluationId, kind, record) => { if (!isId(evaluationId)) throw new EdgeEvalStoreError('INVALID_INPUT', 'evaluationId'); if (!EDGE_EVAL_RECORD_KINDS.includes(kind)) throw new EdgeEvalStoreError('INVALID_INPUT', `record kind ${String(kind).slice(0, 24)}`); if (!record || typeof record !== 'object' || Array.isArray(record)) throw new EdgeEvalStoreError('INVALID_INPUT', 'record'); };
function appendLaw(evaluationId, kind, record, prior, expectSeq, clock) {
  const headSeq = prior.length ? prior[prior.length - 1].seq : 0;
  if (expectSeq !== null && headSeq !== expectSeq) throw new EdgeEvalStoreError('REVISION_CONFLICT', `${evaluationId}: head ${headSeq}, expected ${expectSeq}`);
  checkRead(evaluationId, prior);
  const row = { evaluationId, seq: headSeq + 1, kind, record: structuredClone(record), createdTs: clock(), prevDigest: prior.length ? prior[prior.length - 1].digest : null, digest: null };
  if (!isTs(row.createdTs) || (prior.length && row.createdTs < prior[prior.length - 1].createdTs)) throw new EdgeEvalStoreError('CLOCK_INVALID', `${evaluationId}: the runtime clock moved backwards`);
  const e = recordSemanticsError(row, prior); if (e) throw new EdgeEvalStoreError('RECORD_INVALID', `${evaluationId}: ${e}`);
  row.digest = rowDigest(row);
  const line = `${JSON.stringify(row)}\n`; if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw new EdgeEvalStoreError('RESOURCE_LIMIT_EXCEEDED', 'record too large');
  return { row, line };
}
// ---- file store (one file per evaluation; exclusive lock file per append) -----------------------------------------------------
export function createEdgeEvalStore({ root, clock = () => Date.now(), log = () => {} }) {
  if (typeof root !== 'string' || !root.length) fail('INVALID_REQUEST', 'the edge-eval store needs a research root');
  const dir = path.join(path.resolve(root), EDGE_EVAL_DIR); mkdirSync(dir, { recursive: true });
  const fileOf = (id) => { if (!isId(id) || /[\\/]/.test(id)) throw new EdgeEvalStoreError('INVALID_INPUT', 'evaluationId'); return path.join(dir, `${id}.jsonl`); };
  const readRows = (id) => { const file = fileOf(id); if (!existsSync(file)) return []; const text = readFileSync(file, 'utf8'); const rows = []; for (const line of text.split('\n')) { if (!line.trim()) continue; const p = parseStrictJson(Buffer.from(line, 'utf8'), { maxBytes: MAX_RECORD_BYTES }); if (!p.ok) throw new EdgeEvalStoreError('CHAIN_INVALID', `${id}: unreadable record`); rows.push(p.value); } return rows; };
  const withLock = (id, fn) => { const lock = `${fileOf(id)}.lock`; let fd = null; try { fd = openSync(lock, 'wx'); } catch (err) { throw new EdgeEvalStoreError(err?.code === 'EEXIST' ? 'LOCKED' : 'IO_FAILURE', `${id}: ${err?.code ?? 'lock'}`); } try { return fn(); } finally { try { closeSync(fd); } catch { /* released once */ } try { unlinkSync(lock); } catch { /* best effort */ } } };
  return {
    kind: 'FILE', version: EDGE_EVAL_STORE_VERSION, dir,
    async head(id) { const rows = readRows(id); return rows.length ? deepFreeze(rows[rows.length - 1]) : null; },
    async records(id) { const rows = readRows(id); checkRead(id, rows); return deepFreeze(rows); },
    async state(id) { const rows = readRows(id); checkRead(id, rows); return deepFreeze(chainStateOf(rows)); },
    async append(id, kind, record, { expectSeq = null } = {}) { checkAppend(id, kind, record); return withLock(id, () => { const prior = readRows(id); const { row, line } = appendLaw(id, kind, record, prior, expectSeq, clock); let fd = null; try { fd = openSync(fileOf(id), 'a'); writeSync(fd, line); fsyncSync(fd); } catch (err) { throw new EdgeEvalStoreError('IO_FAILURE', `${id}: append failed (${err?.code ?? 'error'})`); } finally { if (fd !== null) { try { closeSync(fd); } catch { /* once */ } } } log(`edge-eval ${id}: ${kind} #${row.seq}`); return deepFreeze(row); }); },
    async list() { const { readdirSync } = await import('node:fs'); return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).sort(); },
  };
}
// ---- memory twin (offline tests): the same law ---------------------------------------------------------------------------------
export function createMemoryEdgeEvalStore({ clock = () => Date.now(), log = () => {} } = {}) {
  const rows = new Map(); const listOf = (id) => rows.get(id) ?? [];
  return {
    kind: 'MEMORY', version: EDGE_EVAL_STORE_VERSION,
    async head(id) { const l = listOf(id); return l.length ? deepFreeze(structuredClone(l[l.length - 1])) : null; },
    async records(id) { const l = listOf(id).map((r) => structuredClone(r)); checkRead(id, l); return deepFreeze(l); },
    async state(id) { const l = listOf(id).map((r) => structuredClone(r)); checkRead(id, l); return deepFreeze(chainStateOf(l)); },
    async append(id, kind, record, { expectSeq = null } = {}) { checkAppend(id, kind, record); const prior = listOf(id).map((r) => structuredClone(r)); const { row } = appendLaw(id, kind, record, prior, expectSeq, clock); rows.set(id, [...listOf(id), row]); log(`edge-eval ${id}: ${kind} #${row.seq}`); return deepFreeze(structuredClone(row)); },
    async list() { return [...rows.keys()].sort(); },
    // test seam: a forger with write access rewrites one record and re-chains the digests after it — only the semantics can refuse
    _retamper(id, seq, fn) { const l = listOf(id).map((r) => structuredClone(r)); const r = l.find((x) => x.seq === seq); if (r) fn(r); let prev = null; for (const x of l) { x.prevDigest = prev; x.digest = rowDigest(x); prev = x.digest; } rows.set(id, l); },
  };
}
