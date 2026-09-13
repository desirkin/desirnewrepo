import test from 'node:test';
import assert from 'node:assert/strict';
import { createStocktwitsFirestreamClient, stocktwitsFirestreamRequest } from '../rumor2/providers/stocktwits-official.js';
import { collectTiktokResearch, tiktokResearchRequest, tiktokResearchScope } from '../rumor2/providers/tiktok-research-official.js';
import { collectMetaGraph, metaGraphRequest } from '../rumor2/providers/meta-graph-official.js';
import { STOCKTWITS_APPLICATION_ID, STOCKTWITS_USE_CASE_VERSION } from '../rumor2/social-stocktwits.js';
import { TIKTOK_APPLICATION_ID, TIKTOK_USE_CASE_VERSION } from '../rumor2/social-tiktok.js';
import { META_APPLICATION_ID, META_USE_CASE_VERSION } from '../rumor2/social-meta.js';

const NOW = Date.parse('2026-09-07T12:00:00Z');
const stockRecord = {
  ref: 'test/firestream', route: 'FIRESTREAM_MESSAGES', status: 'ATTESTED',
  application: STOCKTWITS_APPLICATION_ID, useCaseVersion: STOCKTWITS_USE_CASE_VERSION,
  permittedUses: ['RETRIEVAL'], additionalTerms: 'NOT_REQUIRED', additionalTermsSatisfied: false,
  validUntil: null, retentionCompatibility: 'COMPATIBLE_REVIEWED', reviewedOn: '2026-09-01',
};
const tiktokRecord = {
  route: 'RESEARCH', approvalRef: 'test/tiktok', status: 'ATTESTED',
  application: TIKTOK_APPLICATION_ID, useCaseVersion: TIKTOK_USE_CASE_VERSION,
  attested: ['ELIGIBLE_INSTITUTION_AFFILIATION', 'NON_COMMERCIAL_RESEARCH_BASIS', 'ETHICS_REVIEW', 'PROJECT_APPROVAL', 'DEVELOPER_ACCOUNT'],
  permittedUses: ['RETRIEVAL'], additionalAgreement: 'REQUIRED', additionalAgreementSatisfied: true,
  validUntil: null, retentionContent: 'COMPATIBLE_REVIEWED', retentionIdentity: 'COMPATIBLE_REVIEWED', reviewedOn: '2026-09-01',
};
const metaRecord = {
  route: 'FACEBOOK_PAGE_PUBLIC_CONTENT', approvalRef: 'test/meta', status: 'ATTESTED',
  application: META_APPLICATION_ID, useCaseVersion: META_USE_CASE_VERSION,
  attested: ['APP_REVIEW', 'BUSINESS_VERIFICATION', 'PUBLIC_CONTENT_ACCESS_FEATURE'],
  permittedUses: ['RETRIEVAL'], additionalAgreement: 'NOT_REQUIRED', additionalAgreementSatisfied: false,
  validUntil: null, retentionContent: 'COMPATIBLE_REVIEWED', retentionIdentity: 'COMPATIBLE_REVIEWED', reviewedOn: '2026-09-01',
};

test('official clients are disabled by default and request descriptors cannot post', async () => {
  let calls = 0;
  const out = await collectTiktokResearch({ enabled: false, accessRecord: tiktokRecord, env: { TIKTOK_CLIENT_KEY: 'secret' }, nowMs: NOW, scope: { startDate: '2026-09-01', endDate: '2026-09-02' }, fetchImpl: async () => { calls += 1; } });
  assert.equal(out.status, 'DISABLED'); assert.equal(calls, 0);
  const req = metaGraphRequest({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', targetId: '123' });
  assert.equal(req.method, 'GET'); assert.equal(req.mutation, false); assert.equal(req.headers.Authorization, 'BEARER_CREDENTIAL_INJECTED_AT_DISPATCH');
  assert.match(stocktwitsFirestreamRequest({ cursor: 'abc' }).url, /seq_id=abc/);
});

test('TikTok Research request boundary distinguishes empty from failed and keeps stable point-in-time ids', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { status: 200, json: async () => ({ data: { videos: [{ id: '7123456789012345678', create_time: 1788778800, video_description: 'research fixture' }] } }) };
  };
  const scope = { startDate: '2026-09-01', endDate: '2026-09-02', maxCount: 10 };
  const a = await collectTiktokResearch({ enabled: true, accessRecord: tiktokRecord, env: { TIKTOK_CLIENT_KEY: 'secret' }, nowMs: NOW, scope, fetchImpl });
  const b = await collectTiktokResearch({ enabled: true, accessRecord: tiktokRecord, env: { TIKTOK_CLIENT_KEY: 'secret' }, nowMs: NOW, scope, fetchImpl });
  assert.equal(a.status, 'OBSERVED'); assert.equal(a.records[0].knownAtTs, NOW); assert.equal(a.records[0].eventId, b.records[0].eventId);
  assert.equal(calls[0].opts.method, 'POST'); assert.equal(JSON.parse(calls[0].opts.body).start_date, '2026-09-01'); assert.equal(calls[0].opts.headers.Authorization, 'Bearer secret');
  const empty = await collectTiktokResearch({ enabled: true, accessRecord: tiktokRecord, env: { TIKTOK_CLIENT_KEY: 'secret' }, nowMs: NOW, scope, fetchImpl: async () => ({ status: 200, json: async () => ({ data: { videos: [] } }) }) });
  assert.equal(empty.ok, true); assert.equal(empty.status, 'EMPTY');
  const failed = await collectTiktokResearch({ enabled: true, accessRecord: tiktokRecord, env: { TIKTOK_CLIENT_KEY: 'secret' }, nowMs: NOW, scope, fetchImpl: async () => ({ status: 429, json: async () => ({}) }) });
  assert.equal(failed.ok, false); assert.equal(failed.status, 'FAILED');
  assert.equal(tiktokResearchRequest({ scope: tiktokResearchScope({ startDate: '2026-01-01', endDate: '2026-02-01' }) }).error, 'DATE_RANGE_EXCEEDS_30_DAYS');
});

test('Meta authorized Graph boundary is route-scoped, read-only, and separates empty from failure', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { status: 200, json: async () => ({ data: [{ id: '1234567890_9876543210', message: 'fixture', created_time: '2026-09-07T10:00:00Z' }] }) }; };
  const got = await collectMetaGraph({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', targetId: '1234567890', enabled: true, accessRecord: metaRecord, env: { META_APP_TOKEN: 'secret' }, nowMs: NOW, fetchImpl });
  assert.equal(got.status, 'OBSERVED'); assert.equal(got.records[0].knownAtTs, NOW); assert.equal(calls[0].opts.method, 'GET'); assert.equal(calls[0].opts.headers.Authorization, 'Bearer secret');
  const empty = await collectMetaGraph({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', targetId: '1234567890', enabled: true, accessRecord: metaRecord, env: { META_APP_TOKEN: 'secret' }, nowMs: NOW, fetchImpl: async () => ({ status: 200, json: async () => ({ data: [] }) }) });
  assert.equal(empty.ok, true); assert.equal(empty.status, 'EMPTY');
  const failed = await collectMetaGraph({ routeId: 'FACEBOOK_PAGE_PUBLIC_CONTENT', targetId: '1234567890', enabled: true, accessRecord: metaRecord, env: { META_APP_TOKEN: 'secret' }, nowMs: NOW, fetchImpl: async () => { throw new Error('fixture network failure'); } });
  assert.equal(failed.ok, false); assert.equal(failed.status, 'FAILED'); assert.match(failed.error, /fixture network failure/);
  const wrong = await collectMetaGraph({ routeId: 'INSTAGRAM_LOGIN', targetId: '123', enabled: true, accessRecord: metaRecord, env: { META_INSTAGRAM_USER_TOKEN: 'secret' }, nowMs: NOW, fetchImpl });
  assert.equal(wrong.status, 'BLOCKED'); assert.ok(wrong.gate.blockers.some((x) => x.startsWith('APPROVAL_ROUTE_MISMATCH')));
});

test('StockTwits Firestream uses injected stream boundary and retries from the opaque cursor', async () => {
  const chunks = [
    `data: ${JSON.stringify({ object: 'Message', action: 'create', seq_id: 'a1', time: '2026-09-07T11:59:00Z', data: { id: '9', body: 'fixture', created_at: '2026-09-07T11:58:00Z', symbols: [{ symbol: 'BTC' }] } })}\n\n`,
  ];
  let attempts = 0; const requests = []; const events = [];
  const transport = async (req) => { attempts += 1; requests.push(req); if (attempts === 1) throw new Error('temporary'); return { status: 200, body: (async function* () { yield chunks[0]; })() }; };
  const client = createStocktwitsFirestreamClient({ enabled: true, accessRecord: stockRecord, env: { STOCKTWITS_STREAM_USER: 'u', STOCKTWITS_STREAM_PASS: 'p' }, scope: { symbols: ['BTC'] }, now: () => NOW, transport, onEvent: (e) => events.push(e), maxReconnects: 2, backoffBaseMs: 0 });
  const out = await client.run();
  assert.equal(out.status, 'OBSERVED'); assert.equal(events.length, 1); assert.equal(events[0].seqId, 'a1'); assert.equal(client.cursor(), 'a1'); assert.equal(requests.length, 2);
  assert.equal(requests[1].cursor, null, 'the first cursor is not adopted until the stream actually yields it');
  const disabled = await createStocktwitsFirestreamClient({ enabled: false, accessRecord: stockRecord, env: {}, scope: { symbols: ['BTC'] }, now: () => NOW, transport }).run();
  assert.equal(disabled.status, 'DISABLED');
});