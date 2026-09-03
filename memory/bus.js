// MEMORY-0 Memory Bus. In-process, zero-dependency, deterministic order:
// publish -> validate -> deduplicate -> append -> notify read-only
// subscribers. One bad subscriber cannot corrupt the publisher; a
// persistence failure fails DARK (loud health, no fake success, no effect
// on any other system). The interface is transport-shaped so a future
// scalable carrier could replace it without rewriting the sensors.
import { validateEnvelope } from './validate.js';
import { MEMORY_SCHEMA_VERSION, MEMORY_VERSION } from './schema.js';

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
};

export class MemoryBus {
  #subscribers = new Set();

  constructor({ store, log = () => {} }) {
    this.store = store;
    this.log = log;
    this.acceptedCount = 0;
    this.rejectedCount = 0;
    this.canonicalRejectedErrors = 0; // schema/provenance rejections THIS session — lost evidence
    this.subscriberErrors = 0;
    this.lastAcceptedTs = null;
    this.closed = false;
  }

  // Read-only subscription: subscribers receive a deep-frozen envelope and
  // their exceptions are contained and counted.
  subscribe(fn) {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  publish(envelope) {
    if (this.closed) return { accepted: false, reason: 'bus closed' };
    const v = validateEnvelope(envelope);
    if (!v.ok) {
      // MEMORY-0B §1: rejected evidence is LOST evidence — memory may not
      // call itself HEALTHY after knowingly losing it. Counting ownership:
      // the bus owns this rejection; the store's own guard (below) fires
      // only for direct callers, so one invalid publish counts exactly once.
      this.rejectedCount++;
      this.canonicalRejectedErrors++;
      this.store.invalidRejectedCount++;
      this.log(`MEMORY DEGRADED: canonical envelope rejected (${v.errors[0] ?? 'invalid'})`);
      return { accepted: false, reason: 'invalid', errors: v.errors };
    }
    const r = this.store.append(envelope, { validatedByBus: true });
    if (!r.accepted) return r;
    this.acceptedCount++;
    this.lastAcceptedTs = Date.now();
    const frozen = deepFreeze(structuredClone(envelope));
    for (const fn of this.#subscribers) {
      try {
        fn(frozen);
      } catch (err) {
        this.subscriberErrors++;
        this.log(`MEMORY subscriber error (contained): ${err.message}`);
      }
    }
    return { accepted: true };
  }

  // Read-only health object (§20, MEMORY-0B §7) — memory never claims
  // health it lacks: HEALTHY requires zero integrity/persistence failures
  // this session AND a healthy recovered store. Deterministic duplicate
  // suppression is normal operation, never degradation.
  health() {
    const status =
      this.store.status !== 'HEALTHY' ? this.store.status : this.canonicalRejectedErrors > 0 ? 'DEGRADED' : 'HEALTHY';
    return deepFreeze({
      status,
      lastAcceptedTs: this.lastAcceptedTs,
      lastPersistedTs: this.store.lastWriteTs,
      queueDepth: 0, // synchronous in-process bus: nothing queues
      acceptedCount: this.acceptedCount,
      rejectedCount: this.rejectedCount,
      canonicalRejectedErrors: this.canonicalRejectedErrors,
      duplicateSuppressedCount: this.store.duplicateSuppressedCount,
      queryIntegrityErrors: this.store.queryIntegrityErrors,
      persistenceErrors: this.store.persistenceErrors,
      subscriberErrors: this.subscriberErrors,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      memoryVersion: MEMORY_VERSION,
    });
  }

  // Safe shutdown: flush the manifest; further publishes are refused.
  close() {
    this.closed = true;
    this.store.flush();
  }
}
