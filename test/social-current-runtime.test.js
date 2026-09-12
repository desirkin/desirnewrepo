import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocialCurrentRuntime } from '../rumor2/social-current-runtime.js';
import { createCurrentSocialStore, currentSocialRecord } from '../rumor2/social-current-store.js';
import { META_ROUTES, META_APPLICATION_ID, META_USE_CASE_VERSION } from '../rumor2/social-meta.js';
import { STOCKTWITS_APPLICATION_ID, STOCKTWITS_USE_CASE_VERSION } from '../rumor2/social-stocktwits.js';
import { replaySocialHistory } from '../rumor2/social-settle.js';
const T=Date.parse('2026-09-12T10:00:00Z');
const reddit={approvalRef:'fixture',status:'APPROVED',application:'SERPENT_PRIVATE_SINGLE_USER',useCaseVersion:'serpent-reddit-use-case-v1',classification:'NON_COMMERCIAL_PERSONAL',permittedUses:['RETRIEVAL'],additionalAgreement:'NOT_REQUIRED',additionalAgreementSatisfied:false,validUntil:null,retentionCompatibility:'COMPATIBLE_REVIEWED',reviewedOn:'2026-09-01'};
const meta=route=>({route,approvalRef:'fixture',status:'ATTESTED',application:META_APPLICATION_ID,useCaseVersion:META_USE_CASE_VERSION,attested:[...META_ROUTES[route].eligibilityRequirements],permittedUses:['RETRIEVAL'],additionalAgreement:'NOT_REQUIRED',additionalAgreementSatisfied:false,validUntil:null,retentionContent:'COMPATIBLE_REVIEWED',retentionIdentity:'COMPATIBLE_REVIEWED',reviewedOn:'2026-09-01'});
function harness(env,records,fetchImpl){let t=T,fence=true;const journal=[];const options={env,records,fetchImpl,now:()=>t,streamWindowMs:20};const make=()=>{const r=createSocialCurrentRuntime(options);assert.equal(r.hydrate(journal).ok,true);r.start();return r;};const hooks={fenceHeld:()=>fence,append:async es=>{for(const e of es)if(!journal.some(x=>x.sourceEventId===e.sourceEventId))journal.push(e);return {ok:true,lastSeq:journal.length};}};return {make,hooks,journal,advance:ms=>{t+=ms;},lose:()=>{fence=false;}};}
test('Reddit OAuth + scoped listing -> erasable current view; journal has counts only, deletion clears content, restart keeps the budget',async()=>{
  let deleted=false,calls=0;const env={RUMOR2_SOCIAL_REDDIT_ENABLED:'true',RUMOR2_SOCIAL_REDDIT_SUBREDDITS:'fixturecrypto',RUMOR2_SOCIAL_REDDIT_USER_AGENT:'nodejs:fixture:1.0 (by /u/fixture)',RUMOR2_SOCIAL_REDDIT_MAX_DAILY_REQUESTS:'3',REDDIT_CLIENT_ID:'fixture-id',REDDIT_CLIENT_SECRET:'fixture-secret'};
  const h=harness(env,{reddit},async(url,init)=>{calls++;assert.ok(!url.includes('fixture-secret'));if(url.includes('access_token')){assert.equal(init.body,'grant_type=client_credentials');return Response.json({access_token:'fixture-token',token_type:'bearer',expires_in:3600});}assert.equal(init.headers.authorization,'Bearer fixture-token');return Response.json({kind:'Listing',data:{children:[{kind:'t3',data:{name:'t3_abc',author_fullname:'t2_xyz',subreddit:'fixturecrypto',title:'Fixture post',selftext:deleted?'[deleted]':'CURRENT CONTENT',created_utc:T/1000-10,author:deleted?'[deleted]':'fixture',permalink:'/r/fixturecrypto/comments/abc'}}],after:null}});});
  let r=h.make();await r.settle(h.hooks);assert.equal(r.snapshot().observations.length,1);assert.equal(r.snapshot().observations[0].text,'CURRENT CONTENT');assert.equal(h.journal.length,2);assert.ok(!JSON.stringify(h.journal).includes('CURRENT CONTENT'));assert.ok(!JSON.stringify(r.status()).includes('t3_abc'));assert.equal(replaySocialHistory(h.journal).ok,true);
  deleted=true;h.advance(60000);await r.settle(h.hooks);assert.equal(r.snapshot().observations.length,0);r.stop();r=h.make();await r.settle(h.hooks);assert.equal(calls,3);assert.equal(r.snapshot().observations.length,0);r.stop();
});
test('Meta Page and Instagram scopes share request accounting but retain separate identities and gates',async()=>{
  const env={RUMOR2_SOCIAL_FACEBOOK_ENABLED:'true',RUMOR2_SOCIAL_INSTAGRAM_ENABLED:'true',RUMOR2_SOCIAL_FACEBOOK_PAGE_IDS:'123',RUMOR2_SOCIAL_INSTAGRAM_HASHTAG_IDS:'456',RUMOR2_SOCIAL_INSTAGRAM_HASHTAG_SCOPE_REVIEW:'APPROVED_ACCOUNT_7_DAY_CAP',META_GRAPH_API_VERSION:'v23.0',META_INSTAGRAM_USER_ID:'789',META_APP_TOKEN:'fixture-meta',RUMOR2_SOCIAL_META_MAX_DAILY_REQUESTS:'2'};
  const h=harness(env,{facebook:meta('FACEBOOK_PAGE_PUBLIC_CONTENT'),instagram:meta('INSTAGRAM_HASHTAG_DISCOVERY')},async(url,init)=>{assert.equal(init.headers.authorization,'Bearer fixture-meta');assert.ok(!url.includes('fixture-meta'));return Response.json({data:url.includes('/feed?')?[{id:'123_1',message:'Facebook fixture',created_time:new Date(T-1000).toISOString(),from:{id:'123'}}]:[{id:'123',caption:'Instagram fixture',timestamp:new Date(T-2000).toISOString(),permalink:'https://www.instagram.com/p/fixture/'}]});});
  const r=h.make();await r.settle(h.hooks);const out=r.snapshot().observations;assert.equal(out.length,2);assert.deepEqual(out.map(o=>o.provider),['META_FACEBOOK','META_INSTAGRAM']);assert.equal(h.journal.length,2);assert.ok(h.journal.every(e=>e.provider==='META_PUBLIC'));h.advance(60000);await r.settle(h.hooks);assert.equal(h.journal.length,2);h.lose();await r.settle(h.hooks);assert.equal(r.snapshot().observations.length,0);r.stop();
});
test('StockTwits licensed message stream handles NDJSON chunking, scoped messages and destroy before current-view delivery',async()=>{
  const env={RUMOR2_SOCIAL_STOCKTWITS_ENABLED:'true',RUMOR2_SOCIAL_STOCKTWITS_SYMBOLS:'BTC.X',RUMOR2_SOCIAL_STOCKTWITS_MAX_DAILY_REQUESTS:'2',RUMOR2_SOCIAL_STOCKTWITS_ACCESS_COST:'INCLUDED',STOCKTWITS_STREAM_USER:'fixture',STOCKTWITS_STREAM_PASS:'fixture-secret'};
  const stocktwits={ref:'fixture',route:'FIRESTREAM_MESSAGES',status:'ATTESTED',application:STOCKTWITS_APPLICATION_ID,useCaseVersion:STOCKTWITS_USE_CASE_VERSION,permittedUses:['RETRIEVAL'],additionalTerms:'NOT_REQUIRED',additionalTermsSatisfied:false,validUntil:null,retentionCompatibility:'COMPATIBLE_REVIEWED',reviewedOn:'2026-09-01'};
  let destroy=false;const h=harness(env,{stocktwits},async(url,init)=>{assert.ok(url.startsWith('https://firestream.stocktwits.com/stream'));assert.ok(init.headers.authorization.startsWith('Basic '));const s=JSON.stringify({object:'Message',action:destroy?'destroy':'create',seq_id:destroy?'opaque2':'opaque1',time:new Date(T).toISOString(),data:{id:1,body:'$BTC fixture',created_at:new Date(T-1000).toISOString(),user:{id:2,username:'fixture'},symbols:[{id:3,symbol:'BTC.X'}]}})+'\n';return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(s.slice(0,15)));c.enqueue(new TextEncoder().encode(s.slice(15)));c.close();}}),{headers:{'content-type':'application/json'}});});
  const r=h.make();await r.settle(h.hooks);assert.equal(r.snapshot().observations.length,1);destroy=true;h.advance(60000);await r.settle(h.hooks);assert.equal(r.snapshot().observations.length,0);assert.ok(h.journal.every(e=>!JSON.stringify(e).includes('fixture-secret')));r.stop();
});
test('Current-store shape, TTL, detached reads and provider-scoped erasure are enforced',()=>{
  let now=T;const s=createCurrentSocialStore({now:()=>now,maxRows:2});const o=currentSocialRecord('REDDIT_OFFICIAL',{nativeId:'t3_1',text:'private'},T);assert.equal(s.upsert({...o,unexpected:'x'}),false);assert.equal(s.upsert(o),true);s.snapshot().observations[0].text='changed';assert.equal(s.snapshot().observations[0].text,'private');now+=300000;assert.equal(s.snapshot().observations.length,0);
});
test('Missing approvals and failed request reservations do not reach a social provider',async()=>{
  let calls=0;const env={RUMOR2_SOCIAL_REDDIT_ENABLED:'true',RUMOR2_SOCIAL_REDDIT_MAX_DAILY_REQUESTS:'1'};const h=harness(env,{},async()=>{calls++;throw new Error('unexpected');});const r=h.make();await r.settle(h.hooks);assert.equal(calls,0);assert.equal(r.snapshot().observations.length,0);r.stop();
});
test('A lost reservation acknowledgement performs zero requests, retries exact bytes, and still honors the daily cap',async()=>{
  let calls=0;const env={RUMOR2_SOCIAL_REDDIT_ENABLED:'true',RUMOR2_SOCIAL_REDDIT_SUBREDDITS:'fixturecrypto',RUMOR2_SOCIAL_REDDIT_USER_AGENT:'nodejs:fixture:1.0 (by /u/fixture)',RUMOR2_SOCIAL_REDDIT_MAX_DAILY_REQUESTS:'1',REDDIT_CLIENT_ID:'fixture-id',REDDIT_CLIENT_SECRET:'fixture-secret'};
  const h=harness(env,{reddit},async()=>{calls++;throw Error('must not reach transport');});const r=h.make();let attempts=[];
  await r.settle({...h.hooks,append:async es=>{attempts.push(JSON.stringify(es));await h.hooks.append(es);return {ok:false};}});
  assert.equal(calls,0);assert.equal(r.status().sources.REDDIT_OFFICIAL.state,'REQUEST_RESERVATION_UNACKNOWLEDGED');
  h.advance(60000);await r.settle({...h.hooks,append:async es=>{attempts.push(JSON.stringify(es));return h.hooks.append(es);}});
  assert.equal(attempts.length,2);assert.equal(attempts[0],attempts[1]);assert.equal(h.journal.length,1);assert.equal(calls,0);assert.equal(r.status().sources.REDDIT_OFFICIAL.state,'BUDGET_STOPPED');r.stop();
});
test('StockTwits never reports a successful connection for a stalled handshake or a truncated NDJSON frame',async()=>{
  const {createStocktwitsCurrentClient}=await import('../rumor2/social-current-clients.js');
  for(const fetchImpl of [async()=>new Promise(()=>{}),async()=>new Response('{"object":"Message"')]){
    const client=createStocktwitsCurrentClient({env:{},now:()=>T,fetchImpl,windowMs:15});
    const result=await client.poll({reserve:async()=>true,signal:new AbortController().signal,valid:()=>true,store:createCurrentSocialStore({now:()=>T})});
    assert.equal(result.ok,false);assert.ok(['STREAM_FAILED','STREAM_TRUNCATED_FRAME'].includes(result.reason));
  }
});

test('Senses reports actual active Farcaster and never calls a stopped current-view collector active from an old receipt',async()=>{
  const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const path=await import('node:path');const {sensorSnapshot,snapshotRow}=await import('../paper/readiness.js');const {loadProfile,profileEnvironment}=await import('../paper/profile.js');
  const dir=mkdtempSync(path.join(tmpdir(),'social-status-')),profile=loadProfile(),env={...profileEnvironment(profile),NEYNAR_API_KEY:'fixture',REDDIT_CLIENT_ID:'fixture'};
  try{mkdirSync(path.join(dir,'rumor2'));writeFileSync(path.join(dir,'rumor2','status.json'),JSON.stringify({tsMs:T,socialFarcaster:{state:'ACTIVE',gateReason:null,lastSuccessTs:T,coverage:'SEARCH_QUERY_EXHAUSTED'},socialCurrent:{state:'DARK',sources:{REDDIT_OFFICIAL:{state:'OBSERVED',lastSuccessTs:T}}}}));const snap=sensorSnapshot({profile,env,dataDir:dir,now:T});assert.equal(snapshotRow(snap,'FARCASTER_OFFICIAL').state,'ACTIVE');assert.equal(snapshotRow(snap,'REDDIT_OFFICIAL').state,'BLOCKED_PROVIDER');}finally{rmSync(dir,{recursive:true,force:true});}
});
