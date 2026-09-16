import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocialCurrentRuntime } from '../rumor2/social-current-runtime.js';
import { createCurrentSocialStore, currentSocialRecord } from '../rumor2/social-current-store.js';
import { replaySocialHistory } from '../rumor2/social-settle.js';
const T=Date.parse('2026-09-12T10:00:00Z');
const reddit={approvalRef:'fixture',status:'APPROVED',application:'SERPENT_PRIVATE_SINGLE_USER',useCaseVersion:'serpent-reddit-use-case-v1',classification:'NON_COMMERCIAL_PERSONAL',permittedUses:['RETRIEVAL'],additionalAgreement:'NOT_REQUIRED',additionalAgreementSatisfied:false,validUntil:null,retentionCompatibility:'COMPATIBLE_REVIEWED',reviewedOn:'2026-09-01'};
function harness(env,records,fetchImpl){let t=T,fence=true;const journal=[];const options={env,records,fetchImpl,now:()=>t,streamWindowMs:20};const make=()=>{const r=createSocialCurrentRuntime(options);assert.equal(r.hydrate(journal).ok,true);r.start();return r;};const hooks={fenceHeld:()=>fence,append:async es=>{for(const e of es)if(!journal.some(x=>x.sourceEventId===e.sourceEventId))journal.push(e);return {ok:true,lastSeq:journal.length};}};return {make,hooks,journal,advance:ms=>{t+=ms;},lose:()=>{fence=false;}};}
test('Reddit OAuth + scoped listing -> erasable current view; journal has counts only, deletion clears content, restart keeps the budget',async()=>{
  let deleted=false,calls=0;const env={RUMOR2_SOCIAL_REDDIT_ENABLED:'true',RUMOR2_SOCIAL_REDDIT_SUBREDDITS:'fixturecrypto',RUMOR2_SOCIAL_REDDIT_USER_AGENT:'nodejs:fixture:1.0 (by /u/fixture)',RUMOR2_SOCIAL_REDDIT_MAX_DAILY_REQUESTS:'3',REDDIT_CLIENT_ID:'fixture-id',REDDIT_CLIENT_SECRET:'fixture-secret'};
  const h=harness(env,{reddit},async(url,init)=>{calls++;assert.ok(!url.includes('fixture-secret'));if(url.includes('access_token')){assert.equal(init.body,'grant_type=client_credentials');return Response.json({access_token:'fixture-token',token_type:'bearer',expires_in:3600});}assert.equal(init.headers.authorization,'Bearer fixture-token');return Response.json({kind:'Listing',data:{children:[{kind:'t3',data:{name:'t3_abc',author_fullname:'t2_xyz',subreddit:'fixturecrypto',title:'Fixture post',selftext:deleted?'[deleted]':'CURRENT CONTENT',created_utc:T/1000-10,author:deleted?'[deleted]':'fixture',permalink:'/r/fixturecrypto/comments/abc'}}],after:null}});});
  let r=h.make();await r.settle(h.hooks);assert.equal(r.snapshot().observations.length,1);assert.equal(r.snapshot().observations[0].text,'CURRENT CONTENT');assert.equal(h.journal.length,2);assert.ok(!JSON.stringify(h.journal).includes('CURRENT CONTENT'));assert.ok(!JSON.stringify(r.status()).includes('t3_abc'));assert.equal(replaySocialHistory(h.journal).ok,true);
  deleted=true;h.advance(60000);await r.settle(h.hooks);assert.equal(r.snapshot().observations.length,0);r.stop();r=h.make();await r.settle(h.hooks);assert.equal(calls,3);assert.equal(r.snapshot().observations.length,0);r.stop();
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
test('Senses reports actual active Farcaster and never calls a stopped current-view collector active from an old receipt',async()=>{
  const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const path=await import('node:path');const {sensorSnapshot,snapshotRow}=await import('../paper/readiness.js');const {loadProfile,profileEnvironment}=await import('../paper/profile.js');
  const dir=mkdtempSync(path.join(tmpdir(),'social-status-')),profile=loadProfile(),env={...profileEnvironment(profile),NEYNAR_API_KEY:'fixture',REDDIT_CLIENT_ID:'fixture'};
  try{mkdirSync(path.join(dir,'rumor2'));writeFileSync(path.join(dir,'rumor2','status.json'),JSON.stringify({tsMs:T,socialFarcaster:{state:'ACTIVE',gateReason:null,lastSuccessTs:T,coverage:'SEARCH_QUERY_EXHAUSTED'},socialCurrent:{state:'DARK',sources:{REDDIT_OFFICIAL:{state:'OBSERVED',lastSuccessTs:T}}}}));const snap=sensorSnapshot({profile,env,dataDir:dir,now:T});assert.equal(snapshotRow(snap,'FARCASTER_OFFICIAL').state,'ACTIVE');assert.equal(snapshotRow(snap,'REDDIT_OFFICIAL').state,'BLOCKED_PROVIDER');}finally{rmSync(dir,{recursive:true,force:true});}
});

test('current-view status expires observations, reports gates before requests, and cannot stay observed after stop', async()=>{
  const env={RUMOR2_SOCIAL_REDDIT_ENABLED:'true',RUMOR2_SOCIAL_REDDIT_SUBREDDITS:'fixturecrypto',RUMOR2_SOCIAL_REDDIT_USER_AGENT:'nodejs:fixture:1.0 (by /u/fixture)',RUMOR2_SOCIAL_REDDIT_MAX_DAILY_REQUESTS:'3',REDDIT_CLIENT_ID:'fixture-id',REDDIT_CLIENT_SECRET:'fixture-secret'};
  let calls=0;
  const h=harness(env,{reddit},async(url)=>{calls++;return Response.json(url.includes('access_token')?{access_token:'fixture-token',token_type:'bearer',expires_in:3600}:{kind:'Listing',data:{children:[],after:null}});});
  const r=h.make();await r.settle(h.hooks);
  assert.equal(r.status().sources.REDDIT_OFFICIAL.state,'CONNECTED_NO_MATCH');
  h.advance(300001);assert.equal(r.status().sources.REDDIT_OFFICIAL.state,'STALE');assert.equal(calls,2);
  r.stop();assert.equal(r.status().sources.REDDIT_OFFICIAL.state,'DARK');
  delete env.REDDIT_CLIENT_SECRET;
  const s=r.status().sources.REDDIT_OFFICIAL;assert.ok(s.gateReason);assert.notEqual(s.state,'CONNECTED_NO_MATCH');assert.equal(calls,2);
});
