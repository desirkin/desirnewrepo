import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTextBounded, fetchJsonBounded } from '../lib/bounded-fetch.js';

const url = 'https://sensor.example/feed';
const base = { host: 'sensor.example', timeoutMs: 50, maxBytes: 8 };
test('sensor transport caps streamed UTF-8 bytes before consuming the full response', { timeout: 1500 }, async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('€€€')); }, cancel() { cancelled = true; } });
  const result = await fetchTextBounded(url, { ...base, fetchImpl: async () => new Response(body) });
  assert.equal(result.outcome, 'FAILED'); assert.match(result.reason, /body over 8 bytes/);
  assert.equal(cancelled, true);
});
test('sensor transport terminates a stalled body even when a transport ignores abort', { timeout: 1500 }, async () => {
  const start = Date.now();
  const result = await fetchTextBounded(url, { ...base, fetchImpl: async () => new Response(new ReadableStream({ start() {} })) });
  assert.equal(result.outcome, 'FAILED'); assert.match(result.reason, /timeout/);
  assert.ok(Date.now() - start < 1500);
});
test('sensor transport refuses to forward credentials across an allowed redirect', async () => {
  const calls = [];
  const result = await fetchTextBounded(url, { ...base, redirectHosts: ['cdn.example'], headers: { authorization: 'Bearer fixture-secret' },
    fetchImpl: async (target, init) => { calls.push({ target, headers: init.headers }); return new Response(null, { status: 302, headers: { location: 'https://cdn.example/feed' } }); } });
  assert.equal(result.outcome, 'FAILED'); assert.equal(calls.length, 1);
});
test('sensor transport preserves HTTP failures even when their JSON looks like successful data', async () => {
  const result = await fetchJsonBounded(url, { ...base, maxBytes: 100, fetchImpl: async () => Response.json({ data: [] }, { status: 403 }) });
  assert.equal(result.outcome, 'FAILED'); assert.equal(result.status, 403);
});
test('sensor transport handles HTTP-date Retry-After and rejects successful HTML as JSON', async () => {
  const future = new Date(Date.now() + 120000).toUTCString();
  const limited = await fetchJsonBounded(url, { ...base, fetchImpl: async () => new Response(null, { status: 429, headers: { 'retry-after': future } }) });
  assert.ok(limited.retryAfterSec >= 118);
  const html = await fetchJsonBounded(url, { ...base, maxBytes: 100, fetchImpl: async () => new Response('{"data":[]}', { headers: { 'content-type': 'text/html' } }) });
  assert.equal(html.outcome, 'PARSE_FAILED');
});

test('bounded source reads exclude torn tails and refuse oversized checkpoints',async()=>{
  const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const path=await import('node:path');const {readJsonlTail,readJsonBounded}=await import('../lib/jsonl.js');
  const dir=mkdtempSync(path.join(tmpdir(),'source-read-')),file=path.join(dir,'rows');
  try{writeFileSync(file,'{"id":1}\n{"id":2}\n{"id":');let r=readJsonlTail(file,{maxBytes:64});assert.equal(r.torn,true);assert.deepEqual(r.lines.map(JSON.parse),[{id:1},{id:2}]);r=readJsonlTail(file,{maxBytes:15});assert.equal(r.truncated,true);assert.ok(r.lines.every(l=>JSON.parse(l).id===2));assert.throws(()=>readJsonBounded(file,3),/bound/);}finally{rmSync(dir,{recursive:true,force:true});}
});
