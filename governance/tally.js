// GOV-1 — Tally provider (INDEXED on-chain governance data; an API key is
// required). NON-NEGOTIABLE hygiene: the key lives ONLY in the environment
// (TALLY_API_KEY), is never logged, never persisted, never placed in
// config, status, source JSONL, Memory, or error messages. Without a key:
// status UNAVAILABLE_MISSING_CREDENTIAL and ZERO Tally network calls —
// Snapshot continues independently, and Snapshot data is never re-labeled
// as Tally's. Even WITH a key, Tally observes nothing until the registry
// carries a verified governorId (it currently carries none): explicit
// mapped identities only, no fuzzy provider linkage.
//
// Tally proposals describe on-chain Governor state as INDEXED BY TALLY —
// provenance says exactly that; we never claim direct chain verification.

export const TALLY_API = 'https://api.tally.xyz/query';
export const TALLY_PROVIDER = 'TALLY';

export function tallyCredential(env = process.env) {
  const key = env.TALLY_API_KEY;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

export function tallyStatus(env = process.env, registry = null) {
  if (!tallyCredential(env)) return 'UNAVAILABLE_MISSING_CREDENTIAL';
  if (!registry || registry.tallyGovernors.length === 0) return 'IDLE_NO_VERIFIED_GOVERNOR_MAPPING';
  return 'CONFIGURED';
}

// One bounded Tally GraphQL POST. Callers MUST have checked the credential;
// this function refuses to run without one rather than sending an
// unauthenticated request. The key travels only in the request header.
export async function tallyGql(query, variables, { fetchImpl = fetch, timeoutMs = 15_000, env = process.env } = {}) {
  const key = tallyCredential(env);
  if (!key) throw new Error('tally credential missing — caller must not reach the network');
  const res = await fetchImpl(TALLY_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'api-key': key },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429) throw new Error('HTTP 429');
  if (!res.ok) throw new Error(`tally HTTP ${res.status}`); // status code only — never response bodies that could echo the key
  const body = await res.json();
  if (body.errors?.length) throw new Error(`tally graphql error (${body.errors.length} error(s))`);
  return body.data;
}

// PURE canonicalization of one Tally proposal into the bounded shape the
// collector observes. Only fields the API truthfully provided are kept;
// execution-state metadata is carried verbatim from the provider vocabulary
// (QUEUED/EXECUTED etc.) because Tally indexes on-chain Governor state —
// but provenance still says "indexed", not "chain-verified".
export function normalizeTallyProposal(raw, governorId) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id ?? raw.onchainId;
  if (id === undefined || id === null) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const stats = raw.voteStats ?? null;
  return {
    provider: TALLY_PROVIDER,
    proposalId: String(id),
    governorId: String(governorId),
    chainId: raw.governor?.chainId ?? raw.chainId ?? null,
    state: typeof raw.status === 'string' ? raw.status : null,
    startTs: num(raw.start?.timestamp),
    endTs: num(raw.end?.timestamp),
    quorumRaw: num(raw.quorum),
    voteStats: Array.isArray(stats)
      ? stats.slice(0, 8).map((s) => ({ type: String(s.type ?? '').slice(0, 20), votesCount: s.votesCount ?? null, percent: num(s.percent) }))
      : null,
    title: typeof raw.metadata?.title === 'string' ? raw.metadata.title.slice(0, 256) : null,
    providerUrl: raw.id ? `https://www.tally.xyz/proposal/${raw.id}` : null,
  };
}
