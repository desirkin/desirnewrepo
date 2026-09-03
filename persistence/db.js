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

export class Db {
  #pool = null;
  #url;

  constructor({ url = process.env.DATABASE_URL, schema = null, log = () => {} } = {}) {
    this.#url = url;
    this.schema = schema; // tests isolate themselves in their own schema
    this.log = log;
    this.connectionErrors = 0;
    this.transactionErrors = 0;
    this.lastSuccessfulReadTs = null;
    this.lastSuccessfulWriteTs = null;
    this.reachable = false;
  }

  configured() {
    return typeof this.#url === 'string' && this.#url.length > 0;
  }

  // Bounded-retry startup connect. "Configured but unreachable" is a state
  // we report truthfully — never a crash, never a fake success.
  async connect() {
    if (!this.configured()) return false;
    if (this.#pool) return this.reachable;
    this.#pool = new pg.Pool({
      connectionString: this.#url,
      max: POOL_MAX,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
      statement_timeout: QUERY_TIMEOUT_MS,
      allowExitOnIdle: true, // persistence never keeps a dying process alive
    });
    this.#pool.on('error', () => {
      this.connectionErrors++;
      this.reachable = false;
    });
    for (let attempt = 1; attempt <= STARTUP_RETRIES; attempt++) {
      try {
        await this.#pool.query('SELECT 1');
        if (this.schema) {
          await this.#pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
        }
        this.reachable = true;
        this.lastSuccessfulReadTs = Date.now();
        return true;
      } catch (err) {
        this.connectionErrors++;
        this.log(`PERSISTENCE connect attempt ${attempt}/${STARTUP_RETRIES} failed: ${err.code ?? err.constructor.name}`);
        if (attempt < STARTUP_RETRIES) await sleep(1000 * attempt);
      }
    }
    this.reachable = false;
    return false;
  }

  #qualify(text) {
    return this.schema ? text.replaceAll('serpent_', `${this.schema}.serpent_`) : text;
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
      if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === '57P01' || err.message?.includes('timeout')) {
        this.connectionErrors++;
        this.reachable = false;
      }
      throw err;
    }
  }

  // One transaction, one client, rolled back on any throw.
  async tx(fn) {
    if (!this.#pool) throw new Error('database not connected');
    const client = await this.#pool.connect();
    const q = (text, params = []) => client.query(this.#qualify(text), params);
    try {
      await q('BEGIN');
      const result = await fn(q);
      await q('COMMIT');
      this.lastSuccessfulWriteTs = Date.now();
      this.reachable = true;
      return result;
    } catch (err) {
      this.transactionErrors++;
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

  async end() {
    if (this.#pool) {
      const p = this.#pool;
      this.#pool = null;
      await p.end().catch(() => {});
    }
  }
}
