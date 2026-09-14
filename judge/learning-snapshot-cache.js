// Prepared learning snapshots only. refresh() belongs to maintenance, never
// admission. read() performs no source call, I/O, cloning or history replay.
// A synchronous source can still block maintenance; this is not CPU isolation.
export function createLearningSnapshotCache({ source, clock = Date.now,
  refreshMs = 60_000, maxAgeMs = 60_000, timeoutMs = 2_000,
  maxBytes = 262_144, maxNodes = 10_000, maxDepth = 32 } = {}) {
  if (typeof source !== 'function' || typeof clock !== 'function') throw new TypeError('source and clock required');
  for (const [key, value] of Object.entries({ refreshMs, maxAgeMs, timeoutMs, maxBytes, maxNodes, maxDepth })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${key} must be a positive finite integer`);
  }
  let snapshot = null; let publishedTs = null; let attemptedTs = null;
  let inFlight = null; let controller = null; let disposed = false;
  let attempts = 0; let accepted = 0; let rejected = 0; let lastError = null;
  const timestamp = () => { const t = clock(); if (!Number.isSafeInteger(t) || t < 0) throw new TypeError('invalid clock'); return t; };
  function immutableCopy(value) {
    let nodes = 0; let estimatedBytes = 0; const ancestors = new Set();
    const copy = (input, depth) => {
      if (++nodes > maxNodes || depth > maxDepth) throw new TypeError('snapshot structure bound');
      if (input === null || typeof input === 'boolean') return input;
      if (typeof input === 'number') { if (!Number.isFinite(input)) throw new TypeError('nonfinite snapshot value'); return input; }
      if (typeof input === 'string') {
        estimatedBytes += Buffer.byteLength(input, 'utf8');
        if (estimatedBytes > maxBytes) throw new TypeError('snapshot byte bound');
        return input;
      }
      if (!input || typeof input !== 'object' || ancestors.has(input)) throw new TypeError('snapshot must be acyclic plain JSON');
      const array = Array.isArray(input);
      if (!array && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw new TypeError('snapshot must be plain JSON');
      ancestors.add(input);
      const keys = Reflect.ownKeys(input);
      if (keys.length > maxNodes || keys.some((key) => typeof key !== 'string')) throw new TypeError('snapshot key bound');
      const out = array ? [] : {};
      if (array && (input.length > maxNodes || keys.length !== input.length + 1)) throw new TypeError('snapshot array shape');
      for (const key of keys) {
        if (array && key === 'length') continue;
        if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new TypeError('snapshot array key');
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new TypeError('snapshot accessor or hidden field');
        estimatedBytes += Buffer.byteLength(key, 'utf8');
        if (estimatedBytes > maxBytes) throw new TypeError('snapshot byte bound');
        Object.defineProperty(out, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
      }
      ancestors.delete(input); return Object.freeze(out);
    };
    const out = copy(value, 0);
    if (Buffer.byteLength(JSON.stringify(out), 'utf8') > maxBytes) throw new TypeError('snapshot byte bound');
    return out;
  }
  function read() {
    if (disposed || !snapshot) return null;
    let now; try { now = timestamp(); } catch { return null; }
    if (now < publishedTs || now < snapshot.preparedTs
        || now - publishedTs > maxAgeMs || now - snapshot.preparedTs > maxAgeMs) return null;
    return snapshot;
  }
  function refresh() {
    if (disposed) return Promise.resolve({ state: 'STOPPED' });
    if (inFlight) return inFlight;
    let startedTs; try { startedTs = timestamp(); } catch { snapshot = null; return Promise.resolve({ state: 'REFUSED', reason: 'CLOCK_INVALID' }); }
    if (attemptedTs !== null && startedTs >= attemptedTs && startedTs - attemptedTs < refreshMs) return Promise.resolve({ state: 'NOT_DUE' });
    attemptedTs = startedTs; snapshot = null; publishedTs = null; attempts += 1;
    controller = new AbortController(); const ownController = controller;
    let expired = false; let settle;
    const result = new Promise((resolve) => { settle = resolve; });
    inFlight = result;
    const timer = setTimeout(() => {
      expired = true; rejected += 1; lastError = 'SOURCE_TIMEOUT'; ownController.abort();
      settle({ state: 'REFUSED', reason: lastError });
      // Keep inFlight latched until the source settles: a timeout does not
      // prove cancellation, so another refresh must not start an overlap.
    }, timeoutMs);
    Promise.resolve().then(() => disposed ? null : source({ nowTs: startedTs, signal: ownController.signal })).then((value) => {
      if (disposed || expired) return;
      const now = timestamp(); const prepared = immutableCopy(value);
      if (!prepared || Array.isArray(prepared) || !Number.isSafeInteger(prepared.preparedTs)
          || prepared.preparedTs < 0 || prepared.preparedTs > now || now < startedTs
          || now - prepared.preparedTs > maxAgeMs) throw new TypeError('snapshot clock invalid or stale');
      snapshot = prepared; publishedTs = now; accepted += 1; lastError = null;
      settle({ state: 'READY', preparedTs: prepared.preparedTs });
    }).catch((error) => {
      if (disposed || expired) return;
      rejected += 1; lastError = String(error?.message ?? error).slice(0, 160); snapshot = null;
      settle({ state: 'REFUSED', reason: lastError });
    }).finally(() => {
      clearTimeout(timer); inFlight = null; controller = null;
      if (disposed) settle({ state: 'STOPPED' });
    });
    return result;
  }
  return Object.freeze({ read, refresh,
    dispose() { disposed = true; snapshot = null; controller?.abort(); },
    status: () => ({ attempts, accepted, rejected, lastError, inFlight: inFlight !== null, disposed, preparedTs: snapshot?.preparedTs ?? null }),
  });
}
