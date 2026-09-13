// Independent acceptance cases for 6596db52263e35e009a77e9e9d1ecc8ccddce717.
// Offline only. This file executes its filesystem fault probes in an isolated child.
// Install as test/market-socrates-6596-owner.test.js. Do not change the assertions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
async function runProbes() {
const ROOT = path.resolve(process.env.COBRA_AUDIT_REPO ?? './audit_6596db5');
const imp = p => import(new URL(`file://${ROOT}/${p}`));
const H = await imp('test/helpers/market-closeout.js');
const { T0, tmp, json, btcOnly } = H;
const { loadPolicy, ALLOWED_MAX_AGE_MS } = await imp('market-lab/policy.js');
const { PROVIDER_IDS, FAMILIES, familyMetricIds, canonicalDigest, makeObservation, observationError, sha256Hex } = await imp('market-lab/contracts.js');
const { ENDPOINTS, providersForFamily } = await imp('market-lab/registry.js');
const { providerReadiness, liveReadinessManifest } = await imp('market-lab/readiness.js');
const { createResearchOwner } = await imp('market-lab/owner.js');
const { createBroker } = await imp('socrates/broker.js');
const { buildContext, contextError, contextIdentity, COMPONENT_KEYS } = await imp('market-lab/context.js');
const { runBuild, readContext } = await imp('market-lab/commands.js');
const { manifestIdentity } = await imp('market-lab/store.js');
const report = (name, values) => console.log(JSON.stringify({name,...values}));

const policy = loadPolicy(H.H.policyWith({providers:[...PROVIDER_IDS]}));
const rows = providerReadiness({policy,env:Object.fromEntries(PROVIDER_IDS.map(id=>[`${id}_API_KEY`,'offline'])),testReport:Object.fromEntries(PROVIDER_IDS.map(id=>[id,'PASSED'])),liveReport:Object.fromEntries(PROVIDER_IDS.map(id=>[id,{state:'PASSED',ts:T0,endpointId:'x',asset:'BTC',evidence:'fixture'}]))});
const qualified = fam => {
  const providerId=providersForFamily(fam)[0];
  const endpointId=ENDPOINTS.find(e=>e.providerId===providerId&&e.families.includes(fam)).endpointId;
  const metrics=familyMetricIds(fam);
  return {providerId,endpointId,requested:2,obtained:2,assets:{requested:['BTC','ETH'],obtained:['BTC','ETH']},metrics:{requested:metrics,obtained:metrics},interval:{startTs:T0-3600000,endTs:T0-500},knownAtTs:T0-500,requestedMaxAgeMs:ALLOWED_MAX_AGE_MS[fam].at(-1),support:{state:'COMPLETE',basis:'SNAPSHOT'},complete:true,nativeLatencyMs:10,smokeTs:null};
};
const familyCoverage=Object.fromEntries(FAMILIES.map(f=>[f,qualified(f)]));
const modelReadiness={liveVerification:'PASSED',demonstration:{ts:T0,model:'offline-model',requestId:'fixture',usage:{inputTokens:10,outputTokens:5}}};
const readiness=(coverage=familyCoverage,model=modelReadiness)=>liveReadinessManifest({rows,familyCoverage:coverage,modelReadiness:model,generatedTs:T0});
assert.equal(readiness().overall,'READINESS_GREEN');
report('readiness control',{overall:readiness().overall});
for(const mutation of ['missing_asset','missing_metric','future_model']){
  const coverage=structuredClone(familyCoverage);const model=structuredClone(modelReadiness);
  if(mutation==='missing_asset'){coverage.NETWORK_ACTIVITY.assets.obtained=['BTC'];coverage.NETWORK_ACTIVITY.obtained=1;}
  if(mutation==='missing_metric')coverage.NETWORK_ACTIVITY.metrics.obtained=coverage.NETWORK_ACTIVITY.metrics.requested.slice(0,1);
  if(mutation==='future_model')model.demonstration.ts=T0+86400000;
  const result=readiness(coverage,model);
  report(mutation,{overall:result.overall,family:result.families.NETWORK_ACTIVITY,modelQualification:result.modelQualification});
}

const kp=loadPolicy(H.H.policyWith({providers:['KRAKEN_SPOT']}));
const d=tmp('audit-bars-');
const own=createResearchOwner({policy:kp,subjects:btcOnly(),clock:()=>T0,researchRoot:d,fetchImpl:async url=>json(new URL(url).pathname.endsWith('AssetPairs')?H.H.KRAKEN_ASSET_PAIRS:H.H.krakenOhlc('XXBTZUSD',{intervalMin:60,endTs:T0,count:62}))});
let bars;
try {await own.clients.KRAKEN_SPOT.loadCatalog();const market=own.clients.KRAKEN_SPOT.resolveMarket({canonicalCoin:'BTC'}).market;const r=await own.clients.KRAKEN_SPOT.ohlc({market,intervalMin:60});assert.equal(r.ok,true);bars=r.observations.filter(o=>o.kind==='CANDLE'&&o.payload.closed);}
finally{await own.stop({seal:false});fs.rmSync(d,{recursive:true,force:true});}
const req={requestKey:'Q1',requestKind:'DETAIL',family:'SPOT_PRICE_CHART',metricIds:['sma','atr14','bollinger20'],subjectRef:'BTC',windowStartTs:null,windowEndTs:null,requestedMaxAgeMs:null,hypothesisRefs:[],question:'q',interpretationIfSupported:'x',interpretationIfContradicted:'y'};
const opts={analysisId:'soc2-'+ 'a'.repeat(40),caseSubject:{canonicalCoin:'BTC',registeredRefs:[]},asOfTs:T0,deadlineTs:T0+60000};
const resolve = obs=>createBroker({owner:{observations:()=>obs,coverage:()=>[],acquire:async()=>({results:[],observations:[]})},policy:kp,clock:()=>T0,mode:'REPLAY_AS_OF'}).resolve(req,opts);
const full=await resolve(bars);assert.equal(full.state,'SATISFIED');
report('bars control',{bars:bars.length,state:full.state});
const latest=bars.at(-1);const {observationId,...base}=latest;
const repeats=Array.from({length:62},(_,i)=>makeObservation({...base,sequence:base.sequence+i+1}));
assert.ok(repeats.every(o=>observationError(o)===null));
assert.equal(new Set(repeats.map(o=>o.observationId)).size,62);
const single=await resolve([latest]);assert.notEqual(single.state,'SATISFIED');
const repeated=await resolve(repeats);
report('native_candle_repeats',{uniquePeriods:new Set(repeats.map(o=>o.periodStartTs)).size,singleState:single.state,state:repeated.state,metrics:repeated.metrics});
const repeatedContext=buildContext({canonicalCoin:'BTC',asOfTs:T0,observations:repeats,captureRef:H.SEALED_REF});
const repeatedIndicator=repeatedContext.context.families.SPOT_PRICE_CHART.components.find(c=>c.metricId==='indicators');
report('native_candle_context',{uniquePeriods:1,closedBars:repeatedIndicator.value.closedBars,sma60:repeatedIndicator.value.sma['60'],pureError:contextError(repeatedContext.context)});

for(const kind of ['budget','quota']){
 const dir=tmp('audit-close-');const module=await imp(kind==='budget'?'socrates/budget.js':'market-lab/quota.js');
 const j=(kind==='budget'?module.openBudgetJournal:module.openQuotaJournal)({dir,clock:()=>T0});
 const originalOpen=fs.openSync;const originalClose=fs.closeSync;const fds=new Set();let injected=0;
 fs.openSync=function(file,...args){const fd=originalOpen.call(this,file,...args);if(String(file)===j.files.journalFile)fds.add(fd);return fd;};
 fs.closeSync=function(fd){const targeted=fds.delete(fd);const r=originalClose.call(this,fd);if(targeted&&injected===0){injected++;throw Object.assign(new Error('injected journal close failure'),{code:'EIO'});}return r;};
 syncBuiltinESMExports();
 let first,second,error=null,secondError=null;
 const reserve=id=>kind==='budget'?j.reserve({reservationId:id,caseId:id,attemptId:id,estimatedUsd:1,inputTokens:1000000,maxOutputTokens:0,pricing:{inputUsdPerMTok:1,outputUsdPerMTok:1,cacheReadUsdPerMTok:1,cacheWriteUsdPerMTok:1},caps:{maxEstimatedUsdPerCase:10,maxEstimatedUsdPerDay:10,maxEstimatedUsdPerMonth:10,totalSmokeMaxEstimatedUsd:1}}):j.reserve({providerId:'KRAKEN_SPOT',endpointId:'rest-ticker',unit:'CALL',credits:1,chargedOn:'DISPATCH',purpose:'ACQUIRE',requestKey:id,estimatedUsd:0});
 try{try{first=reserve('r1');}catch(e){error=e.code;}try{second=reserve('r2');}catch(e){secondError=e.code;}report(`${kind}_close_error`,{injected,error,secondError,first,second,latched:j.failed(),reservations:j.reservations().length});}
 finally{fs.openSync=originalOpen;fs.closeSync=originalClose;syncBuiltinESMExports();j.close();fs.rmSync(dir,{recursive:true,force:true});}
}

const dir=tmp('audit-context-'),cap=path.join(dir,'capture'),ctxDir=path.join(dir,'context'),schedules=[];
const timers={setInterval:(fn,ms)=>{const x={fn,ms,unref(){}};schedules.push(x);return x;},clearInterval(){},setTimeout,clearTimeout};
const co=createResearchOwner({policy:kp,subjects:btcOnly(),clock:()=>T0,mode:'INTEGRATED',researchRoot:dir,timers,fetchImpl:async()=>json(H.H.KRAKEN_ASSET_PAIRS)});
try{
 await co.start({outDir:cap,families:[]});co.observer.onBook({coin:'BTC',symbol:'BTC/USD',receivedTs:T0,synced:true,checksumVerified:true,pricePrecision:1,qtyPrecision:8,levels:()=>({bids:[[99.5,2]],asks:[[100.5,2]]})});for(const s of schedules)if(s.ms===250)s.fn();await co.stop({seal:true});runBuild({captureDir:cap,asOfTs:T0,canonicalCoin:'BTC',out:ctxDir});readContext(ctxDir);
 const ctx=JSON.parse(fs.readFileSync(path.join(ctxDir,'context.json'),'utf8'));
 assert.equal(contextError(ctx),null);
 report('context control',{valid:true,reopened:true});
 const list=ctx.families.DISPLAYED_LIQUIDITY.components;const index=list.findIndex(c=>c.metricId==='spread_bps');assert.ok(index>=0);
 const [c]=list.splice(index,1);c.family='NETWORK_ACTIVITY';ctx.families.NETWORK_ACTIVITY.components.push(c);ctx.families.NETWORK_ACTIVITY.state='OBSERVED';
 c.componentId='mcc-'+canonicalDigest(Object.fromEntries(COMPONENT_KEYS.filter(k=>k!=='componentId').map(k=>[k,c[k]]))).slice(0,40);ctx.contextId=contextIdentity(ctx);
 const cov=JSON.parse(fs.readFileSync(path.join(ctxDir,'coverage.json'),'utf8'));for(const [fam,f] of Object.entries(ctx.families)){cov.families[fam].state=f.state;cov.families[fam].components=f.components.length;}
 const mf=JSON.parse(fs.readFileSync(path.join(ctxDir,'manifest.json'),'utf8'));
 for(const [name,value] of [['context.json',ctx],['coverage.json',cov]]){const bytes=Buffer.from(JSON.stringify(value,null,1)+'\n');fs.writeFileSync(path.join(ctxDir,name),bytes);const member=mf.members.find(m=>m.name===name);member.bytes=bytes.length;member.sha256=sha256Hex(bytes);}
 mf.summary.contextId=ctx.contextId;mf.bundleId=manifestIdentity(mf);fs.writeFileSync(path.join(ctxDir,'manifest.json'),JSON.stringify(mf,null,1)+'\n');
 let reopened=false,error=null;try{readContext(ctxDir);reopened=true;}catch(e){error={code:e.code,message:e.message};}
 report('wrong_component_family',{metric:c.metricId,family:c.family,pureError:contextError(ctx),reopened,error});
}finally{await co.stop({seal:false});fs.rmSync(dir,{recursive:true,force:true});}

}
if (process.env.COBRA_OWNER_PROBE_CHILD === '1') {
  await runProbes();
} else {
  const repo = process.env.COBRA_AUDIT_REPO
    ? path.resolve(process.env.COBRA_AUDIT_REPO)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: repo,
    env: { ...process.env, COBRA_AUDIT_REPO: repo, COBRA_OWNER_PROBE_CHILD: '1' },
    encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30000
  });
  assert.equal(child.error, undefined, `probe child could not run: ${child.error?.code}`);
  assert.equal(child.status, 0, `lawful fixture construction failed, not a RED acceptance case: ${child.stderr}`);
  const records = child.stdout.trim().split('\n').map(line => JSON.parse(line));
  const result = name => {
    const found = records.find(row => row.name === name);
    assert.ok(found, `missing witness ${name}`);
    return found;
  };
  test('IR-C01: the existing complete readiness control stays green', () => {
    assert.equal(result('readiness control').overall, 'READINESS_GREEN');
  });
  test('IR-C02: actual contiguous closed bars satisfy indicator warmup', () => {
    const r=result('bars control'); assert.ok(r.bars>=60); assert.equal(r.state,'SATISFIED');
  });
  test('IR-C03: a lawful populated capture builds and reopens a context', () => {
    assert.deepEqual(result('context control'), {name:'context control',valid:true,reopened:true});
  });
  for (const [id,name] of [['IR-N01','missing_asset'],['IR-N02','missing_metric'],['IR-N03','future_model']]) {
    test(`${id}: ${name} must not produce READINESS_GREEN`, () => {
      assert.notEqual(result(name).overall,'READINESS_GREEN',`${name} is not complete evidence at this clock`);
    });
  }
  test('IR-N04: one native candle repeated under 62 envelope identities cannot warm up the broker', () => {
    const r=result('native_candle_repeats');
    assert.equal(r.uniquePeriods,1); assert.equal(r.singleState,'PARTIAL');
    assert.notEqual(r.state,'SATISFIED','envelope copies are not sixty independent closed periods');
    for (const m of ['sma','atr14','bollinger20']) assert.notEqual(r.metrics[m].state,'SATISFIED');
  });
  test('IR-N05: context derivation cannot manufacture a 60-bar SMA from one repeated native period', () => {
    const r=result('native_candle_context');
    assert.equal(r.uniquePeriods,1); assert.equal(r.pureError,null,'lawful repeated input needs truthful derivation');
    assert.equal(r.closedBars,1,'count the selected native periods, not collection envelopes');
    assert.equal(r.sma60,null,'insufficient history must preserve warmup null');
  });
  for (const [id,kind] of [['IR-N06','budget'],['IR-N07','quota']]) {
    test(`${id}: ${kind} journal close EIO surfaces and latches before another allowance`, () => {
      const r=result(`${kind}_close_error`); assert.equal(r.injected,1,'the intended seam was reached');
      assert.equal(r.error,'IO_FAILURE','a successful fsync does not authorize swallowing the reported close error');
      assert.ok(r.latched,'accounting failure must remain visible');
      assert.equal(r.secondError,'IO_FAILURE','a later reservation must hit the accounting latch');
      assert.equal(r.second,undefined,'no second successful reservation');
    });
  }
  test('IR-N08: context validator rejects a spread component relabelled NETWORK_ACTIVITY', () => {
    const r=result('wrong_component_family');assert.equal(r.metric,'spread_bps');assert.equal(r.family,'NETWORK_ACTIVITY');
    assert.equal(typeof r.pureError,'string','family/metric binding must be checked independently of hashes');
  });
  test('IR-N09: actual saved-context reader rejects wrong family after valid resealing', () => {
    const r=result('wrong_component_family');assert.equal(r.reopened,false,'wrong family reopened with valid checksums and counts');
    assert.ok(['INVALID_INPUT','VALIDATION_FAILURE','CORRUPT_INPUT'].includes(r.error?.code));
    assert.doesNotMatch(r.error.message,/checksum|sha256|digest|does not match content|bundleId|byte size/i,'must reach semantic validation');
  });
}
