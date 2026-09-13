// RIPE RIS Live public BGP stream. The endpoint and subscription protocol are
// fixed to the official RIS Live service. This module intentionally emits
// normalized observations rather than making routing decisions.
import { createHash } from 'node:crypto';

export const RIPE_RIS_LIVE_URL = 'wss://ris-live.ripe.net/v1/ws/';
export const RIPE_RIS_MAX_MESSAGE_BYTES = 1 * 1024 * 1024;
export const RIPE_RIS_MAX_RECONNECTS = 12;

const nowIso = (clock) => new Date(clock()).toISOString();
const bounded = (value, max) => typeof value === 'string' && value.length <= max ? value : null;

export function buildRisSubscription({ host = 'rrc00', type = 'UPDATE', require: required = null, moreSpecific = null } = {}) {
  if (!/^rrc\d{2}$/.test(host) || !['UPDATE', 'RIS_PEER_DOWN', 'RIS_PEER_UP'].includes(type)) {
    throw new Error('invalid RIS Live subscription');
  }
  if (required !== null && (typeof required !== 'string' || required.length === 0 || required.length > 120)) {
    throw new Error('invalid RIS Live subscription');
  }
  if (moreSpecific !== null && typeof moreSpecific !== 'boolean') throw new Error('invalid RIS Live subscription');
  const data = { host, type };
  if (required !== null) data.require = required;
  if (moreSpecific !== null) data.moreSpecific = moreSpecific === true;
  return { type: 'ris_subscribe', data };
}

const eventTimestamp = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 2e10 ? value : value * 1000;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

export function normalizeRisMessage(message, { clock = () => Date.now(), endpoint = RIPE_RIS_LIVE_URL } = {}) {
  if (!message || message.type !== 'ris_message' || !message.data || typeof message.data !== 'object') return null;
  const raw = message.data;
  const attrs = raw.attrs && typeof raw.attrs === 'object' ? raw.attrs : raw;
  const receivedTs = clock();
  const sourceTs = eventTimestamp(raw.timestamp ?? attrs.timestamp);
  const nativeCandidate = raw.id ?? attrs.id;
  const nativeId = typeof nativeCandidate === 'string' || typeof nativeCandidate === 'number'
    ? bounded(String(nativeCandidate), 200) || null
    : null;
  const identity = nativeId ?? createHash('sha256').update(JSON.stringify({
    host: raw.host ?? null, peer: raw.peer ?? null, prefix: attrs.prefix ?? null,
    announced: attrs.announced ?? null, withdrawn: attrs.withdrawn ?? null, path: attrs.path ?? null,
  })).digest('hex').slice(0, 32);
  return {
    type: 'BGP_UPDATE',
    id: identity,
    host: bounded(String(raw.host ?? ''), 40),
    peer: bounded(String(raw.peer ?? ''), 80),
    peerAsn: Number.isSafeInteger(raw.peer_asn) ? raw.peer_asn : null,
    prefix: bounded(String(attrs.prefix ?? ''), 80),
    announced: attrs.announced === true,
    withdrawn: attrs.withdrawn === true,
    path: Array.isArray(attrs.path) ? attrs.path.slice(0, 512) : [],
    sourceEventTs: sourceTs,
    receivedTs,
    provenance: {
      provider: 'RIPE_RIS_LIVE',
      endpoint,
      sourceTimestamp: sourceTs,
      receivedTs,
      receivedAt: new Date(receivedTs).toISOString(),
    },
  };
}

export function createRipeRisLiveStream({
  WebSocketImpl = globalThis.WebSocket,
  clock = () => Date.now(),
  random = Math.random,
  onEvent = () => {},
  onOutcome = () => {},
  onError = () => {},
  host = 'rrc00',
  type = 'UPDATE',
  require: required = null,
  moreSpecific = null,
  endpoint = RIPE_RIS_LIVE_URL,
  maxMessageBytes = RIPE_RIS_MAX_MESSAGE_BYTES,
  maxReconnects = RIPE_RIS_MAX_RECONNECTS,
  reconnectBaseMs = 1_000,
  reconnectMaxMs = 60_000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  dedupeSize = 10_000,
} = {}) {
  if (endpoint !== RIPE_RIS_LIVE_URL) throw new Error('RIS Live endpoint is fixed to the official public service');
  let socket = null; let timer = null; let stableTimer = null; let running = false;
  let state = 'STOPPED'; let reconnects = 0; let sequence = 0; let lastOutcome = null;
  const seen = new Map();
  const subscription = buildRisSubscription({ host, type, require: required, moreSpecific });
  const outcome = (status, detail = {}) => {
    lastOutcome = { status, ...detail, ts: clock(), at: nowIso(clock) };
    onOutcome(lastOutcome);
  };
  const forgetOldest = () => { while (seen.size > dedupeSize) seen.delete(seen.keys().next().value); };
  const remember = (key) => {
    if (seen.has(key)) return false;
    seen.set(key, clock());
    forgetOldest();
    return true;
  };
  const delay = () => {
    const exp = Math.min(20, Math.max(0, reconnects - 1));
    const jitter = 0.8 + Math.max(0, Math.min(1, Number(random()) || 0)) * 0.4;
    return Math.min(reconnectMaxMs, Math.round(reconnectBaseMs * (2 ** exp) * jitter));
  };
  const schedule = () => {
    if (!running || reconnects >= maxReconnects) {
      if (running) { state = 'FAILED'; outcome('FAILED', { code: 'RECONNECT_LIMIT', reconnects }); }
      return;
    }
    const waitMs = delay();
    state = 'BACKOFF';
    outcome('BACKOFF', { waitMs, reconnects });
    timer = setTimeoutImpl(() => { timer = null; connect(); }, waitMs);
  };
  const parse = async (raw) => {
    let text;
    if (typeof raw === 'string') text = raw;
    else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(raw));
    else if (ArrayBuffer.isView(raw)) text = new TextDecoder().decode(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    else if (raw && typeof raw.text === 'function') text = await raw.text();
    else return onError({ code: 'MESSAGE_TYPE', message: 'RIS message type is unsupported' });
    if (new TextEncoder().encode(text).byteLength > maxMessageBytes) return onError({ code: 'MESSAGE_TOO_LARGE', message: 'RIS message exceeded the byte limit' });
    let decoded;
    try { decoded = JSON.parse(text); } catch { return onError({ code: 'INVALID_JSON', message: 'RIS message was not valid JSON' }); }
    const event = normalizeRisMessage(decoded, { clock, endpoint });
    if (!event) return onOutcome({ status: 'IGNORED', reason: 'UNRECOGNIZED_MESSAGE', ts: clock(), at: nowIso(clock) });
    if (!remember(event.id)) return onOutcome({ status: 'DEDUPED', id: event.id, ts: clock(), at: nowIso(clock) });
    onEvent({ ...event, sequence: ++sequence });
    outcome('DATA', { id: event.id, sourceTimestamp: event.sourceEventTs });
  };
  const connect = () => {
    if (!running) return;
    if (typeof WebSocketImpl !== 'function') { state = 'FAILED'; onError({ code: 'WEBSOCKET_UNAVAILABLE', message: 'WebSocket is unavailable' }); return; }
    state = 'CONNECTING';
    try { socket = new WebSocketImpl(endpoint); } catch (error) { onError({ code: 'CONNECT_FAILED', message: error?.name ?? 'connection failed' }); reconnects += 1; return schedule(); }
    socket.onopen = () => {
      if (!running) return;
      state = 'ACTIVE'; outcome('CONNECTED', { reconnects });
      try { socket.send(JSON.stringify(subscription)); } catch { onError({ code: 'SUBSCRIBE_FAILED', message: 'RIS subscription could not be sent' }); socket.close?.(); }
      stableTimer = setTimeoutImpl(() => { stableTimer = null; reconnects = 0; }, 30_000);
    };
    socket.onmessage = (event) => { parse(event.data).catch(() => onError({ code: 'MESSAGE_READ_FAILED', message: 'RIS message could not be read' })); };
    socket.onerror = () => onError({ code: 'STREAM_ERROR', message: 'RIS stream reported an error' });
    socket.onclose = () => {
      socket = null;
      if (!running) return;
      clearTimeoutImpl(stableTimer); stableTimer = null;
      reconnects += 1; outcome('DISCONNECTED', { reconnects }); schedule();
    };
  };
  return {
    start() { if (!running) { running = true; reconnects = 0; connect(); } return this; },
    stop() { running = false; state = 'STOPPED'; clearTimeoutImpl(timer); clearTimeoutImpl(stableTimer); timer = null; stableTimer = null; socket?.close?.(); socket = null; outcome('STOPPED'); },
    status() { return { state, running, reconnects, sequence, dedupeSize: seen.size, lastOutcome }; },
    subscription,
    endpoint,
  };
}