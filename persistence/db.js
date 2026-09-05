// PERSIST-0 — database boundary. The ONLY file that touches the pg driver
// directly. DATABASE_URL comes from the environment alone; it is never
// logged, never echoed, never reachable from browser JavaScript. The
// deployment filesystem is a cache; this is the durable authority's door.
import pg from 'pg';

const POOL_MAX = 5; // one personal app, one small pool
const CONNECT_TIMEOUT_MS = 5000;
const QUERY_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 30_000;
const STARTUP_RETRIES = 3; // bounded — no infinite reconnect storm

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PERSIST-0A — ONE shared connection-failure classifier for connect/probe,
// query() and tx(). A dead transaction must mark the database unreachable
// exactly as a dead query does, so the permission lock tells the truth.
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08000',
  '08003',
  '08006', // connection exceptions
]);
export function isConnectionError(err) {
  if (!err) return false;
  if (CONNECTION_ERROR_CODES.has(err.code)) return true;
  const msg = String(err.message ?? '');
  return /timeout|terminated|connection (closed|ended|refused)/i.test(msg);
}

export class Db {
  #pool = null;
  #url;
  #poolFactory;
  #retries;
  #everConnected = false;
  #lockClients = new Set(); // advisory-lock sessions checked out for their lifetime

  constructor({ url = process.env.DATABASE_URL, schema = null, log = () => {}, poolFactory = null, retries = STARTUP_RETRIES } = {}) {
    this.#url = url;
    this.schema = schema; // tests isolate themselves in their own schema
    this.log = log;
    this.#poolFactory = poolFactory; // test seam: adversarial pools for reconnect drills
    this.#retries = retries;
    this.connectionErrors = 0;
    this.transactionErrors = 0;
    this.lastSuccessfulReadTs = null;
    this.lastSuccessfulWriteTs = null;
    this.reachable = false;
  }

  configured() {
    return typeof this.#url === 'string' && this.#url.length > 0;
  }

  #markConnectionFailure(err) {
    if (isConnectionError(err)) {
      this.connectionErrors++;
      this.reachable = false;
      return true;
    }
    return false;
  }

  #ensurePool() {
    if (this.#pool) return;
    const opts = {
      connectionString: this.#url,
      max: POOL_MAX,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
      statement_timeout: QUERY_TIMEOUT_MS,
      allowExitOnIdle: true, // persistence never keeps a dying process alive
    };
    this.#pool = this.#poolFactory ? this.#poolFactory(opts) : new pg.Pool(opts);
    this.#pool.on('error', () => {
      this.connectionErrors++;
      this.reachable = false;
    });
  }

  // Connect OR re-probe. The first call creates the pool and retries a
  // bounded number of times; every later call PROBES the existing pool with
  // one real round-trip, so an outage that ends is actually noticed — a pool
  // is never created per retry (no reconnect storm), and a failed pool is
  // never treated as permanently dead.
  async connect() {
    if (!this.configured()) return false;
    this.#ensurePool();
    const attempts = this.#everConnected || this.connectionErrors > 0 ? 1 : this.#retries;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.#pool.query('SELECT 1');
        if (this.schema) {
          await this.#pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
        }
        this.reachable = true;
        this.#everConnected = true;
        this.lastSuccessfulReadTs = Date.now();
        return true;
      } catch (err) {
        this.connectionErrors++;
        this.log(`PERSISTENCE connect probe ${attempt}/${attempts} failed: ${err.code ?? err.constructor.name}`);
        if (attempt < attempts) await sleep(1000 * attempt);
      }
    }
    this.reachable = false;
    return false;
  }

  #qualify(text) {
    return this.schema ? text.replaceAll('serpent_', `${this.schema}.serpent_`) : text;
  }

  // Schema-qualified relation name for the rare statement that cannot carry
  // 'serpent_' in generated SQL text (e.g. dynamic constraint maintenance).
  qualifiedName(name) {
    return this.schema ? `${this.schema}.${name}` : name;
  }

  async query(text, params = [], { write = false } = {}) {
    if (!this.#pool) throw new Error('database not connected');
    try {
      const r = await this.#pool.query(this.#qualify(text), params);
      this.reachable = true;
      if (write) this.lastSuccessfulWriteTs = Date.now();
      else this.lastSuccessfulReadTs = Date.now();
      return r;
    } catch (err) {
      this.#markConnectionFailure(err);
      throw err;
    }
  }

  // One transaction, one client, rolled back on any throw. A connection
  // death inside a transaction marks the database unreachable — the error's
  // location never hides the outage from the permission lock. fn receives
  // (q, helpers): q qualifies 'serpent_' names; helpers.raw does not.
  async tx(fn) {
    if (!this.#pool) throw new Error('database not connected');
    let client;
    try {
      client = await this.#pool.connect();
    } catch (err) {
      this.#markConnectionFailure(err);
      throw err;
    }
    const q = (text, params = []) => client.query(this.#qualify(text), params);
    const helpers = { raw: (text, params = []) => client.query(text, params), db: this };
    try {
      await q('BEGIN');
      const result = await fn(q, helpers);
      await q('COMMIT');
      this.lastSuccessfulWriteTs = Date.now();
      this.reachable = true;
      return result;
    } catch (err) {
      this.transactionErrors++;
      this.#markConnectionFailure(err);
      try {
        await q('ROLLBACK');
      } catch {
        // rollback failure implies the connection died; counted above
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // RUMOR-2 freeze seal — one named session-scoped advisory lock. Advisory
  // locks belong to a PostgreSQL SESSION, and the pool reaps idle sessions,
  // so the winning client stays CHECKED OUT for the lock's whole lifetime
  // (one of the pool's five slots, deliberately long-lived). The server
  // releases the lock automatically when the session dies — process crash,
  // connection loss, pg_terminate_backend — which is exactly the failover
  // law the writer fence needs. Returns null when another session holds the
  // lock; otherwise a handle: held() turns false when the underlying
  // connection dies, release() unlocks and returns the client to the pool.
  async acquireSessionLock(name) {
    if (!this.#pool) throw new Error('database not connected');
    let client;
    try {
      client = await this.#pool.connect();
    } catch (err) {
      this.#markConnectionFailure(err);
      throw err;
    }
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [name]);
      if (!rows[0].ok) {
        client.release();
        return null; // another writer holds authority — fail safely, no busy loop
      }
    } catch (err) {
      client.release();
      this.#markConnectionFailure(err);
      throw err;
    }
    let lost = false;
    const onDeath = () => {
      lost = true;
    };
    client.on('error', onDeath);
    client.once('end', onDeath);
    this.#lockClients.add(client); // so end() can never hang on a held lock
    const release = async () => {
      client.removeListener('error', onDeath);
      client.removeListener('end', onDeath);
      this.#lockClients.delete(client);
      try {
        if (!lost) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name]);
      } catch {
        // a dead session already released the lock server-side
      }
      try {
        client.release();
      } catch {
        // already released/destroyed — nothing leaks either way
      }
    };
    // A query bound to THIS lock-owning session (schema-qualified like
    // db.query). It is how the writer epoch is advanced ON the very session
    // that holds the advisory lock: if that session dies, this query cannot
    // succeed, so a non-owner can never advance the epoch. A dead session
    // throws; a connection failure marks the pool unreachable exactly as
    // db.query does.
    const query = async (text, params = []) => {
      if (lost) throw Object.assign(new Error('lock session lost'), { code: 'LOCK_SESSION_LOST' });
      try {
        return await client.query(this.#qualify(text), params);
      } catch (err) {
        this.#markConnectionFailure(err);
        throw err;
      }
    };
    return { held: () => !lost, release, query };
  }

  async end() {
    // A held advisory-lock client is checked out for its lifetime, and
    // pool.end() waits for every client to return — so release the locks
    // FIRST or shutdown would hang (and the process would never exit).
    for (const client of this.#lockClients) {
      try {
        client.release(true); // destroy: the session (and its locks) end with it
      } catch {
        // already gone — nothing to reclaim
      }
    }
    this.#lockClients.clear();
    if (this.#pool) {
      const p = this.#pool;
      this.#pool = null;
      await p.end().catch(() => {});
    }
  }
}
