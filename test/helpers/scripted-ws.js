// A scripted Kraken executions-channel WebSocket double (focused completion N02): the FULL lifecycle the adapter drives —
// construction with the fixed URL, asynchronous open, the subscribe request carrying the token, the venue's subscription
// acknowledgement, native executions messages with sequence numbers (gaps included), ping / pong, a venue-side drop
// (reconnect), and the owner's close. Nothing here reaches a network: it is the venue, scripted.
export function createScriptedWebSocket({ ackSubscriptions = true, onSend = null } = {}) {
  const sockets = []; const log = [];
  class ScriptedWebSocket {
    constructor(url) { this.url = String(url); this.readyState = 0; this.sent = []; this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null; this.closedByOwner = false; sockets.push(this); log.push({ event: 'CONSTRUCT', url: this.url }); setTimeout(() => { if (this.readyState !== 0) return; this.readyState = 1; log.push({ event: 'OPEN', url: this.url }); this.onopen?.({ type: 'open' }); }, 0); }
    send(text) { if (this.readyState !== 1) throw new Error('socket not open'); const raw = String(text); this.sent.push(raw); let msg = null; try { msg = JSON.parse(raw); } catch { msg = null; } log.push({ event: 'SEND', method: msg?.method ?? null });
      if (msg?.method === 'subscribe' && ackSubscriptions) { const token = msg.params?.token; this.token = typeof token === 'string' ? `${token.slice(0, 4)}…` : null; setTimeout(() => this.deliver({ method: 'subscribe', success: true, result: { channel: msg.params?.channel ?? 'executions', snap_orders: Boolean(msg.params?.snap_orders), snap_trades: Boolean(msg.params?.snap_trades) }, time_in: new Date().toISOString(), time_out: new Date().toISOString() }), 0); }
      if (msg?.method === 'ping') setTimeout(() => this.deliver({ method: 'pong', req_id: msg.req_id, time_in: new Date().toISOString(), time_out: new Date().toISOString() }), 0);
      if (onSend) onSend(this, msg, raw); }
    // the venue speaks: a native message (object or exact wire text)
    deliver(msg) { if (this.readyState !== 1) return false; const data = typeof msg === 'string' ? msg : JSON.stringify(msg); log.push({ event: 'MESSAGE', channel: msg?.channel ?? msg?.method ?? null }); this.onmessage?.({ data }); return true; }
    executions(records, { sequence, type = 'update' } = {}) { return this.deliver({ channel: 'executions', type, sequence, data: records }); }
    // the venue drops the connection (not the owner): the adapter must treat it as a gap and reconnect
    drop(reason = 'venue closed') { if (this.readyState === 3) return; this.readyState = 3; log.push({ event: 'DROP', reason }); this.onclose?.({ type: 'close', code: 1006, reason, wasClean: false }); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.closedByOwner = true; log.push({ event: 'OWNER_CLOSE' }); this.onclose?.({ type: 'close', code: 1000, reason: 'owner', wasClean: true }); }
  }
  return { WebSocketImpl: ScriptedWebSocket, sockets, log, latest: () => sockets[sockets.length - 1] ?? null, subscribed: (i = sockets.length - 1) => Boolean(sockets[i]?.sent.some((r) => r.includes('"subscribe"'))) };
}
