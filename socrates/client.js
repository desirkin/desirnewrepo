// SOCRATES V2 — the REAL Anthropic Messages API client (§10.3) over native fetch: approved host only, ANTHROPIC_API_KEY
// by env NAME (the value enters only the request header), explicit model id, AbortSignal + timeout, bounded response
// consumption, actual content-block / stop_reason / usage parsing. Refusal, truncation, invalid JSON, wrong schema,
// transport failure and rate limits are DISTINCT outcomes. Non-text (thinking) blocks are never report text. No
// automatic repair loop, no max_tokens escalation, no silent model fallback: the response's actual model id is recorded.
import { parseStrictJson, sha256Hex } from '../market-lab/contracts.js';

export const ANTHROPIC_VERSION = '2023-06-01';
export const MESSAGES_PATH = '/v1/messages';
export const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';
export const CLIENT_FAILURE_KINDS = Object.freeze(['CREDENTIAL_MISSING', 'HOST_NOT_APPROVED', 'TIMEOUT', 'CANCELLED', 'NETWORK', 'HTTP_401', 'HTTP_403', 'HTTP_429', 'HTTP_4XX', 'HTTP_5XX', 'BODY_TOO_LARGE', 'JSON_INVALID', 'SCHEMA', 'REFUSAL', 'TRUNCATED', 'NO_TEXT', 'MODEL_MISMATCH']);
export const APPROVED_HOSTS = Object.freeze(['api.anthropic.com']);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const num = (v) => (Number.isSafeInteger(v) ? v : null);

export function createAnthropicClient({ apiKey, apiHost = 'api.anthropic.com', fetchImpl = globalThis.fetch, clock = () => Date.now(), log = () => {} }) {
  if (!APPROVED_HOSTS.includes(apiHost)) throw Object.assign(new Error('model api host is not approved'), { kind: 'HOST_NOT_APPROVED' });
  const keyPresent = typeof apiKey === 'string' && apiKey.length > 0;
  const failure = (kind, reason, extra = {}) => ({ ok: false, failure: { kind, reason: String(reason).slice(0, 160), ...extra } });
  async function post(path, body, { signal, timeoutMs, expectBytes = MAX_RESPONSE_BYTES }) {
    if (!keyPresent) return failure('CREDENTIAL_MISSING', 'no api key supplied (env name resolves to nothing)', { dispatched: false });
    // dispatched is an EXPLICIT fact: false only when the request provably never left this process
    const controller = new AbortController(); const onAbort = () => controller.abort(); if (signal) { if (signal.aborted) return failure('CANCELLED', 'cancelled before dispatch', { dispatched: false }); signal.addEventListener('abort', onAbort, { once: true }); }
    const timer = setTimeout(() => controller.abort(), timeoutMs); const startedTs = clock(); const json = JSON.stringify(body);
    try {
      let res; try { res = await fetchImpl(`https://${apiHost}${path}`, { method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json', accept: 'application/json' }, body: json, signal: controller.signal, redirect: 'manual' }); }
      catch (err) { if (signal?.aborted) return failure('CANCELLED', 'cancelled after dispatch', { startedTs, dispatched: true, ambiguousCharge: true }); if (controller.signal.aborted) return failure('TIMEOUT', `no response within ${timeoutMs} ms`, { startedTs, dispatched: true, ambiguousCharge: true }); return failure('NETWORK', err?.name ?? 'fetch failed', { startedTs, dispatched: true, ambiguousCharge: true }); }
      const requestId = res.headers.get('request-id') ?? res.headers.get('x-request-id') ?? null; const status = res.status;
      if (status >= 300 && status < 400) return failure('NETWORK', 'redirect refused', { status, requestId, startedTs, dispatched: true, ambiguousCharge: true });
      const chunks = []; let total = 0; const reader = res.body?.getReader?.();
      if (reader) { for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > expectBytes) { try { await reader.cancel(); } catch { /* ignore */ } return failure('BODY_TOO_LARGE', 'response exceeds the byte cap', { status, requestId, startedTs, dispatched: true, ambiguousCharge: true }); } chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength)); } }
      else { const ab = Buffer.from(await res.arrayBuffer()); if (ab.byteLength > expectBytes) return failure('BODY_TOO_LARGE', 'response exceeds the byte cap', { status, requestId, startedTs, dispatched: true, ambiguousCharge: true }); chunks.push(ab); total = ab.byteLength; }
      const bytes = Buffer.concat(chunks, total); const receivedTs = clock(); const parsed = parseStrictJson(bytes, { maxBytes: expectBytes });
      const errType = parsed.ok && parsed.value && typeof parsed.value === 'object' && parsed.value.type === 'error' ? String(parsed.value.error?.type ?? 'error').slice(0, 60) : null;
      const base = { status, requestId, startedTs, receivedTs, durationMs: receivedTs - startedTs, bytes: total, responseSha256: sha256Hex(bytes), dispatched: true, retryAfterMs: status === 429 ? (Number(res.headers.get('retry-after')) || 60) * 1000 : null };
      if (status === 401) return failure('HTTP_401', errType ?? 'authentication error', base); if (status === 403) return failure('HTTP_403', errType ?? 'permission error', base); if (status === 429) return failure('HTTP_429', errType ?? 'rate limited', base); if (status >= 500) return failure('HTTP_5XX', errType ?? `server error ${status}`, { ...base, ambiguousCharge: true }); if (status >= 400) return failure('HTTP_4XX', errType ?? `request error ${status}`, base);
      if (!parsed.ok) return failure('JSON_INVALID', parsed.error, { ...base, ambiguousCharge: true });
      return { ok: true, ...base, json: parsed.value, requestBytes: Buffer.byteLength(json, 'utf8') };
    } finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); }
  }
  // POST /v1/messages and parse the actual response blocks
  async function messages({ body, expectedModel, signal = null, timeoutMs = 90_000 }) {
    const r = await post(MESSAGES_PATH, body, { signal, timeoutMs });
    if (!r.ok) return r;
    const j = r.json; if (!j || typeof j !== 'object' || j.type !== 'message' || !Array.isArray(j.content)) return { ok: false, failure: { kind: 'SCHEMA', reason: 'response is not a message object', requestId: r.requestId, status: r.status, startedTs: r.startedTs, receivedTs: r.receivedTs, dispatched: true, ambiguousCharge: true } };
    const u = j.usage && typeof j.usage === 'object' ? j.usage : {};
    const usage = { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cacheCreationInputTokens: num(u.cache_creation_input_tokens) ?? 0, cacheReadInputTokens: num(u.cache_read_input_tokens) ?? 0 };
    const actualModel = typeof j.model === 'string' ? j.model.slice(0, 80) : null; const stopReason = typeof j.stop_reason === 'string' ? j.stop_reason.slice(0, 40) : null;
    const textBlocks = j.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string'); const nonText = j.content.length - textBlocks.length; const text = textBlocks.map((b) => b.text).join('');
    const meta = { requestId: r.requestId, responseId: typeof j.id === 'string' ? j.id.slice(0, 80) : null, actualModel, stopReason, usage, nonTextBlocks: nonText, startedTs: r.startedTs, receivedTs: r.receivedTs, durationMs: r.durationMs, requestBytes: r.requestBytes, responseBytes: r.bytes, responseSha256: r.responseSha256, outputBytes: Buffer.byteLength(text, 'utf8'), dispatched: true };
    if (expectedModel && actualModel && !actualModel.startsWith(expectedModel)) return { ok: false, failure: { kind: 'MODEL_MISMATCH', reason: 'response model differs from the pinned model', ...meta } };
    if (stopReason === 'refusal') return { ok: false, failure: { kind: 'REFUSAL', reason: 'the model refused', ...meta } };
    if (stopReason === 'max_tokens') return { ok: false, failure: { kind: 'TRUNCATED', reason: 'output truncated at max_tokens', ...meta } };
    if (!text.length) return { ok: false, failure: { kind: 'NO_TEXT', reason: 'no text block in the response', ...meta } };
    return { ok: true, text, ...meta };
  }
  async function countTokens({ body, signal = null, timeoutMs = 30_000 }) {
    const { max_tokens, output_config, ...rest } = body; const r = await post(COUNT_TOKENS_PATH, rest, { signal, timeoutMs });
    if (!r.ok) return r; const n = num(r.json?.input_tokens); return n === null || n < 0 ? { ok: false, failure: { kind: 'SCHEMA', reason: 'input_tokens missing or not a non-negative safe integer', dispatched: true } } : { ok: true, inputTokens: n, requestId: r.requestId };
  }
  return { messages, countTokens, keyPresent, apiHost };
}
// strict JSON parse of the model's text (duplicate keys / hazards / unsafe numbers reject)
export function parseModelJson(text, { maxBytes = 65_536 } = {}) { const p = parseStrictJson(text, { maxBytes }); return p.ok ? { ok: true, value: p.value } : { ok: false, kind: 'JSON_INVALID', reason: p.error }; }
