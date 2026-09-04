// GOV-1 — the VERSIONED GOVERNANCE REGISTRY. Governance identity is
// explicitly mapped, NEVER guessed: a symbol reaches a DAO/space/governor
// only through a verified entry here. Ticker similarity, project-name
// resemblance, proposal titles, domains, chains, and search ranking create
// NOTHING. Governance that cannot be defensibly attached to one tradable
// asset keeps symbol:null — better than a guess.
//
// The initial verified set is populated ONLY from the Childhood deep-memory
// Snapshot mapping (childhood/deepmemory.js SNAPSHOT_SPACES) — mappings the
// project already verified for historical retrieval. Childhood itself is
// untouched: this is option B of the GOV-1 ticket (a new explicit registry
// seeded from already-verified mappings), not a live mirror of Childhood.

export const GOVERNANCE_REGISTRY_VERSION = 1;
export const MAX_MAPPED_ENTITIES = 64; // hard cap on canonical asset mappings

const SYMBOL_RE = /^[A-Z0-9]{1,15}$/;
const PROVIDERS = new Set(['SNAPSHOT', 'TALLY']);
const SCOPES = new Set(['TOKEN_GOVERNANCE']);

// The verified seed — identical space ids to the Childhood verified mapping.
export const VERIFIED_MAPPINGS = Object.freeze([
  { symbol: 'UNI', provider: 'SNAPSHOT', spaceId: 'uniswapgovernance.eth', scope: 'TOKEN_GOVERNANCE', verified: true, mappingVersion: 1 },
  { symbol: 'CRV', provider: 'SNAPSHOT', spaceId: 'curve.eth', scope: 'TOKEN_GOVERNANCE', verified: true, mappingVersion: 1 },
  { symbol: 'AAVE', provider: 'SNAPSHOT', spaceId: 'aave.eth', scope: 'TOKEN_GOVERNANCE', verified: true, mappingVersion: 1 },
  { symbol: 'ARB', provider: 'SNAPSHOT', spaceId: 'arbitrumfoundation.eth', scope: 'TOKEN_GOVERNANCE', verified: true, mappingVersion: 1 },
  { symbol: 'OP', provider: 'SNAPSHOT', spaceId: 'opcollective.eth', scope: 'TOKEN_GOVERNANCE', verified: true, mappingVersion: 1 },
  // TALLY governor mappings: none verified yet. Tally support exists behind
  // TALLY_API_KEY but observes nothing until a verified governorId lands
  // here — no fuzzy provider linkage, ever.
]);

// Strict entry validation — a malformed mapping is rejected and reported,
// never silently repaired.
export function validateRegistryEntry(e) {
  const errors = [];
  if (!e || typeof e !== 'object') return { ok: false, errors: ['entry is not an object'] };
  if (e.symbol !== null && (typeof e.symbol !== 'string' || !SYMBOL_RE.test(e.symbol))) errors.push('symbol must be a strict token or null');
  if (!PROVIDERS.has(e.provider)) errors.push(`provider ${e.provider} is not in the documented enum`);
  if (e.provider === 'SNAPSHOT' && (typeof e.spaceId !== 'string' || !e.spaceId.length || e.spaceId.length > 128)) {
    errors.push('SNAPSHOT mapping requires a bounded spaceId');
  }
  if (e.provider === 'TALLY' && (typeof e.governorId !== 'string' || !e.governorId.length || e.governorId.length > 200)) {
    errors.push('TALLY mapping requires a bounded governorId');
  }
  if (!SCOPES.has(e.scope)) errors.push(`scope ${e.scope} is not in the documented enum`);
  if (e.verified !== true) errors.push('only verified:true mappings are usable — heuristic mappings do not exist');
  if (!Number.isInteger(e.mappingVersion) || e.mappingVersion < 1) errors.push('mappingVersion must be a positive integer');
  return { ok: errors.length === 0, errors };
}

// Load a registry: validate every entry, reject the malformed loudly, and
// enforce the entity cap (entries beyond it are refused, not trimmed
// silently — the refusal is reported). GOV-1A: a configured cap
// (governance.maxMappedSymbols) narrows the limit; the absolute system
// ceiling MAX_MAPPED_ENTITIES always stands.
export function loadRegistry(entries = VERIFIED_MAPPINGS, { cap = MAX_MAPPED_ENTITIES } = {}) {
  const effectiveCap = Math.min(Number.isInteger(cap) && cap > 0 ? cap : MAX_MAPPED_ENTITIES, MAX_MAPPED_ENTITIES);
  const accepted = [];
  const rejected = [];
  for (const e of entries) {
    const v = validateRegistryEntry(e);
    if (!v.ok) {
      rejected.push({ entry: e, errors: v.errors });
      continue;
    }
    if (accepted.length >= effectiveCap) {
      rejected.push({ entry: e, errors: [`registry cap ${effectiveCap} reached — entry refused`] });
      continue;
    }
    accepted.push(Object.freeze({ ...e }));
  }
  const bySpace = new Map();
  const byGovernor = new Map();
  for (const e of accepted) {
    if (e.provider === 'SNAPSHOT') bySpace.set(e.spaceId, e);
    if (e.provider === 'TALLY') byGovernor.set(e.governorId, e);
  }
  return Object.freeze({
    version: GOVERNANCE_REGISTRY_VERSION,
    entries: Object.freeze(accepted),
    rejected: Object.freeze(rejected),
    snapshotSpaces: Object.freeze([...bySpace.keys()]),
    tallyGovernors: Object.freeze([...byGovernor.keys()]),
    // EXACT identity lookups only — there is no fuzzy path
    entryForSpace: (spaceId) => bySpace.get(spaceId) ?? null,
    entryForGovernor: (governorId) => byGovernor.get(governorId) ?? null,
  });
}
