// PERSIST-1 object-store substrate (2026-09-14). Replit wipes the container filesystem on every publish, so the bulk
// streams that are too large for the 1-MiB store anchors — broad-Kraken segments, deep market captures, all of
// data/learning/, tape sessions, the survey / gateway / infra / discovery / video files — need a DURABLE external
// bucket plus an uploader and a restore-on-boot. This module is the bottom of that build: the adapter CONTRACT every
// higher layer speaks, a dependency-free FILESYSTEM backend (the lawful default and the one tests use — point it at a
// persistent mount or a mounted bucket), and the env-NAME-only configuration resolver. Provider selection is
// fail-closed: an unset provider is DISABLED (no upload, no restore, honest — never a silent success), and S3 / GCS are
// NOT_COMMISSIONED until their client is wired (the seam is named, the credential NAMES are reported present/absent,
// and no value is ever read into a payload or a log). Nothing here holds trading authority.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, readdir, stat, lstat, unlink, rm } from 'node:fs/promises';

export const OBJECT_STORE_VERSION = 'serpent-object-store-1';
export const OBJECT_STORE_PROVIDERS = Object.freeze(['NONE', 'FILESYSTEM', 'S3', 'GCS']);
// A single object is bulk but still bounded: a stream segment or a captured file, never an unbounded archive in one put.
export const MAX_OBJECT_BYTES = 256 * 1024 * 1024;

// The env NAMES this substrate reads. Values are never returned, logged, or embedded; presence is reported as a boolean.
export const OBJECT_STORE_ENV = Object.freeze({
  provider: 'SERPENT_OBJECT_STORE_PROVIDER',
  dir: 'SERPENT_OBJECT_STORE_DIR',
  bucket: 'SERPENT_OBJECT_STORE_BUCKET',
  prefix: 'SERPENT_OBJECT_STORE_PREFIX',
  endpoint: 'SERPENT_OBJECT_STORE_ENDPOINT',
  region: 'SERPENT_OBJECT_STORE_REGION',
});
// The credential NAMES each remote provider requires — reported present/absent, never read as a value here.
export const OBJECT_STORE_CREDENTIAL_NAMES = Object.freeze({
  S3: Object.freeze(['SERPENT_OBJECT_STORE_ACCESS_KEY_ID', 'SERPENT_OBJECT_STORE_SECRET_ACCESS_KEY']),
  GCS: Object.freeze(['SERPENT_OBJECT_STORE_GCS_SERVICE_ACCOUNT_JSON']),
});

// Object keys: lower-case ASCII POSIX-ish segments, no traversal, no leading slash, no trailing-dot aliases — the same
// discipline the store-anchor relative paths hold, widened only to allow the key length a manifest of files needs.
const KEY_RE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)*$/;
const PREFIX_RE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)*$/;
const bounded = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 180);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export class ObjectStoreError extends Error {
  constructor(code, message) {
    super(`${code}: ${bounded(message)}`);
    this.name = 'ObjectStoreError';
    this.code = code;
  }
}

export function objectKeyError(key) {
  if (typeof key !== 'string' || key.length < 1 || key.length > 512) return 'object key must be 1..512 characters';
  if (key.includes('\\') || key.startsWith('/') || /^[A-Za-z]:/.test(key)) return 'object key must be a relative POSIX path';
  if (!KEY_RE.test(key)) return 'object key must be lower-case ASCII with safe POSIX segments';
  const segments = key.split('/');
  if (segments.some((s) => s === '.' || s === '..')) return 'object key traversal is forbidden';
  if (segments.some((s) => s.endsWith('.'))) return 'object key trailing-dot aliases are forbidden';
  if (segments.some((s) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(s))) return 'object key contains a reserved cross-platform segment';
  return null;
}
const assertKey = (key) => { const e = objectKeyError(key); if (e) throw new ObjectStoreError('OBJECT_KEY_INVALID', e); };

// Resolve the object-store configuration from the environment by NAME only. Pure: no disk, no network, no value ever
// returned for a credential. `credentials` reports each required NAME present/absent so preflight and status can show
// what is missing without exposing anything. This is the ONE place provider selection is decided.
export function resolveObjectStoreConfig(env = process.env) {
  const rawProvider = typeof env[OBJECT_STORE_ENV.provider] === 'string' ? env[OBJECT_STORE_ENV.provider].trim().toUpperCase() : '';
  const provider = rawProvider === '' ? 'NONE' : rawProvider;
  const prefixRaw = typeof env[OBJECT_STORE_ENV.prefix] === 'string' ? env[OBJECT_STORE_ENV.prefix].trim() : '';
  const base = { version: OBJECT_STORE_VERSION, provider, prefix: prefixRaw || null, missing: [], credentials: {} };

  if (!OBJECT_STORE_PROVIDERS.includes(provider)) {
    return { ...base, state: 'MISCONFIGURED', reason: `${OBJECT_STORE_ENV.provider} must be one of ${OBJECT_STORE_PROVIDERS.join(' | ')}` };
  }
  if (prefixRaw && (prefixRaw.length > 200 || !PREFIX_RE.test(prefixRaw) || prefixRaw.split('/').some((s) => s === '.' || s === '..' || s.endsWith('.')))) {
    return { ...base, state: 'MISCONFIGURED', reason: `${OBJECT_STORE_ENV.prefix} is not a safe key prefix` };
  }
  if (provider === 'NONE') {
    return { ...base, state: 'DISABLED', reason: `${OBJECT_STORE_ENV.provider} is unset; bulk streams are not durably backed and are lost on republish` };
  }
  if (provider === 'FILESYSTEM') {
    const dir = typeof env[OBJECT_STORE_ENV.dir] === 'string' ? env[OBJECT_STORE_ENV.dir].trim() : '';
    if (!dir) return { ...base, state: 'MISCONFIGURED', reason: `${OBJECT_STORE_ENV.provider}=FILESYSTEM requires ${OBJECT_STORE_ENV.dir}`, missing: [OBJECT_STORE_ENV.dir] };
    return { ...base, state: 'CONFIGURED', dir: path.resolve(dir) };
  }
  // S3 / GCS: the client is not commissioned in this repo. Report the exact seam and which credential NAMES are present.
  const names = OBJECT_STORE_CREDENTIAL_NAMES[provider] ?? [];
  const credentials = Object.fromEntries(names.map((n) => [n, typeof env[n] === 'string' && env[n].length > 0]));
  const bucket = typeof env[OBJECT_STORE_ENV.bucket] === 'string' ? env[OBJECT_STORE_ENV.bucket].trim() : '';
  const missing = [];
  if (!bucket) missing.push(OBJECT_STORE_ENV.bucket);
  for (const n of names) if (!credentials[n]) missing.push(n);
  return { ...base, state: 'NOT_COMMISSIONED', credentials, missing, bucket: bucket || null,
    reason: `${provider} object-store client is not commissioned in this build (persistence/object-store.js provider registry); the uploader and restore-on-boot stay dark until it is wired` };
}

// ---- FILESYSTEM backend --------------------------------------------------------------------------------------------
// A durable bucket rooted at one directory. Atomic put (temp + fsync + rename), bounded read, digest-checked, key-safe.
// It never escapes its root (validated key + realpath containment), never follows a symlink, and holds no authority.
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
function createFilesystemBackend({ dir, prefix, log }) {
  const root = prefix ? path.join(dir, ...prefix.split('/')) : dir;
  const fileFor = (key) => { assertKey(key); const f = path.resolve(root, ...key.split('/')); if (!inside(root, f)) throw new ObjectStoreError('OBJECT_KEY_ESCAPES_ROOT', key); return f; };

  return Object.freeze({
    provider: 'FILESYSTEM',
    async put(key, bytes, { contentType = null } = {}) {
      void contentType; // the filesystem backend stores raw bytes; content type rides the manifest, not the object
      if (!Buffer.isBuffer(bytes)) throw new ObjectStoreError('OBJECT_PAYLOAD_INVALID', 'put requires a Buffer');
      if (bytes.byteLength > MAX_OBJECT_BYTES) throw new ObjectStoreError('OBJECT_TOO_LARGE', `${bytes.byteLength} bytes exceeds the ${MAX_OBJECT_BYTES} object cap`);
      const file = fileFor(key);
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
      let handle;
      try {
        handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        await handle.writeFile(bytes);
        await handle.sync();
      } finally { await handle?.close(); }
      try { await rename(tmp, file); }
      catch (error) { try { await unlink(tmp); } catch { /* best effort */ } throw new ObjectStoreError('OBJECT_PUT_FAILED', error?.code ?? error?.message ?? error); }
      return { key, bytes: bytes.byteLength, sha256: sha256(bytes) };
    },
    async get(key) {
      const file = fileFor(key);
      let handle;
      try {
        const meta = await lstat(file);
        if (meta.isSymbolicLink() || !meta.isFile()) return null;
        if (meta.size > MAX_OBJECT_BYTES) throw new ObjectStoreError('OBJECT_TOO_LARGE', `${meta.size} bytes exceeds the ${MAX_OBJECT_BYTES} object cap`);
        handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const before = await handle.stat();
        const buf = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < buf.length) { const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset); if (bytesRead === 0) throw new ObjectStoreError('OBJECT_CHANGED_DURING_READ', key); offset += bytesRead; }
        const after = await handle.stat();
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new ObjectStoreError('OBJECT_CHANGED_DURING_READ', key);
        return buf;
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error instanceof ObjectStoreError) throw error;
        throw new ObjectStoreError('OBJECT_GET_FAILED', error?.code ?? error?.message ?? error);
      } finally { await handle?.close(); }
    },
    async head(key) {
      const file = fileFor(key);
      try { const meta = await lstat(file); if (meta.isSymbolicLink() || !meta.isFile()) return null; return { key, bytes: meta.size }; }
      catch (error) { if (error?.code === 'ENOENT') return null; throw new ObjectStoreError('OBJECT_HEAD_FAILED', error?.code ?? error?.message ?? error); }
    },
    async list(listPrefix = '') {
      const out = [];
      const start = listPrefix ? (() => { const e = objectKeyError(`${listPrefix.replace(/\/$/, '')}/probe`); if (e) throw new ObjectStoreError('OBJECT_PREFIX_INVALID', e); return path.resolve(root, ...listPrefix.replace(/\/$/, '').split('/')); })() : root;
      if (start !== root && !inside(root, start) && start !== root) throw new ObjectStoreError('OBJECT_PREFIX_ESCAPES_ROOT', listPrefix);
      async function walk(current) {
        let entries;
        try { entries = await readdir(current, { withFileTypes: true }); }
        catch (error) { if (error?.code === 'ENOENT') return; throw new ObjectStoreError('OBJECT_LIST_FAILED', error?.code ?? error?.message ?? error); }
        for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
          const full = path.join(current, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) { await walk(full); continue; }
          if (!entry.isFile()) continue;
          if (entry.name.endsWith('.tmp')) continue;
          const key = path.relative(root, full).split(path.sep).join('/');
          if (objectKeyError(key)) continue;
          const meta = await stat(full);
          out.push({ key, bytes: meta.size });
        }
      }
      await walk(start);
      return out.sort((a, b) => (a.key < b.key ? -1 : 1));
    },
    async delete(key) {
      const file = fileFor(key);
      try { await unlink(file); return true; }
      catch (error) { if (error?.code === 'ENOENT') return false; throw new ObjectStoreError('OBJECT_DELETE_FAILED', error?.code ?? error?.message ?? error); }
    },
    describe: () => ({ provider: 'FILESYSTEM', root, prefix: prefix ?? null }),
    log,
  });
}

// Open the configured object store. Returns a frozen handle whose `state` is authoritative: ACTIVE carries `adapter`
// (the contract above), while DISABLED / NOT_COMMISSIONED / MISCONFIGURED carry no adapter and a reason — a caller must
// check `state === 'ACTIVE'` before uploading or restoring. FILESYSTEM ensures its root exists; a create failure is a
// MISCONFIGURED gate, never a thrown boot failure. S3 / GCS return their NOT_COMMISSIONED gate unchanged.
export async function openObjectStore({ env = process.env, log = () => {} } = {}) {
  const config = resolveObjectStoreConfig(env);
  if (config.state !== 'CONFIGURED') {
    if (config.state === 'DISABLED') log(`OBJECT STORE disabled: ${OBJECT_STORE_ENV.provider} unset (bulk streams not durably backed)`);
    else log(`OBJECT STORE ${config.state}: ${config.reason}`);
    return Object.freeze({ ...config, adapter: null, describe: () => ({ provider: config.provider, state: config.state }) });
  }
  try {
    await mkdir(config.prefix ? path.join(config.dir, ...config.prefix.split('/')) : config.dir, { recursive: true });
  } catch (error) {
    log(`OBJECT STORE misconfigured: filesystem root not writable (${bounded(error?.code ?? error?.message ?? error)})`);
    return Object.freeze({ ...config, state: 'MISCONFIGURED', adapter: null, reason: `filesystem root not writable: ${bounded(error?.code ?? error?.message ?? error)}`, describe: () => ({ provider: 'FILESYSTEM', state: 'MISCONFIGURED' }) });
  }
  const adapter = createFilesystemBackend({ dir: config.dir, prefix: config.prefix, log });
  log(`OBJECT STORE active: FILESYSTEM root ${adapter.describe().root}`);
  return Object.freeze({ ...config, state: 'ACTIVE', adapter, describe: adapter.describe });
}

// Remove an object store's own tree (FILESYSTEM only) — used by tests to clean a temp root. Never used in production.
export async function _destroyFilesystemObjectStore(root) { await rm(root, { recursive: true, force: true }); }
