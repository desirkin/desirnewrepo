// Independent native-history acceptance cases for f6532bf. Offline fixtures only.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {rmSync} from 'node:fs';
const root=process.env.COBRA_AUDIT_REPO ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const imp=p=>import(pathToFileURL(path.join(root,p)).href);
const {T0,tmp,json,btcOnly,H,SEALED_REF}=await imp('test/helpers/market-closeout.js');
const {loadPolicy}=await imp('market-lab/policy.js');
const {createResearchOwner}=await imp('market-lab/owner.js');
const {makeObservation,observationError}=await imp('market-lab/contracts.js');
const {selectNativeSeries}=await imp('market-lab/native-series.js');
const {indicators}=await imp('market-lab/recipes.js');
const {buildContext,contextError}=await imp('market-lab/context.js');
const policy=loadPolicy(H.policyWith({providers:['KRAKEN_SPOT']})),dir=tmp('audit-native-');
const own=createResearchOwner({policy,subjects:btcOnly(),clock:()=>T0,researchRoot:dir,fetchImpl:async u=>json(new URL(u).pathname.endsWith('AssetPairs')?H.KRAKEN_ASSET_PAIRS:H.krakenOhlc('XXBTZUSD',{intervalMin:60,endTs:T0,count:63}))});
let bars;
try{await own.clients.KRAKEN_SPOT.loadCatalog();const market=own.clients.KRAKEN_SPOT.resolveMarket({canonicalCoin:'BTC'}).market;bars=(await own.clients.KRAKEN_SPOT.ohlc({market,intervalMin:60})).observations.filter(o=>o.kind==='CANDLE'&&o.payload.closed);}finally{await own.stop({seal:false});rmSync(dir,{recursive:true,force:true});}
const ctx=obs=>{const b=buildContext({canonicalCoin:'BTC',asOfTs:T0,observations:obs,captureRef:SEALED_REF});const c=b.context.families.SPOT_PRICE_CHART.components.find(c=>c.metricId==='indicators');return {error:contextError(b.context),count:c.value.closedBars,sma60:c.value.sma[60],support:c.support,selection:c.value.completeness.selection,inputs:c.inputObservationCount};};

const changed=(o,over)=>{const {observationId,...rest}=o;return makeObservation({...rest,...over,payload:{...rest.payload,...(over.payload??{})}});};
test('NS-C01: complete real fixture series generates valid context and numeric SMA60',()=>{
 assert.equal(bars.length,62);assert.ok(bars.every(o=>observationError(o)===null));
 const c=ctx(bars);assert.equal(c.error,null);assert.equal(c.count,62);assert.equal(typeof c.sma60,'number');
});
test('NS-C02: one closed native period keeps SMA60 unavailable',()=>{
 const c=ctx([bars.at(-1)]);assert.equal(c.error,null);assert.equal(c.count,1);assert.equal(c.sma60,null);
});
test('NS-N01: reference aliasing cannot change selected periods or numerical context',()=>{
 const repeated=Array(62).fill(bars.at(-1)); const deserialized=JSON.parse(JSON.stringify(repeated));
 const selected=selectNativeSeries(repeated); const other=selectNativeSeries(deserialized);
 assert.equal(selected.selectedPeriods,1);assert.equal(other.selected.length,1);
 assert.equal(selected.selected.length,1,'one winner must be emitted once even when its object occurs repeatedly');
 const c=ctx(repeated);assert.equal(c.count,1);assert.equal(c.sma60,null);assert.deepEqual(c,ctx(deserialized));
});
test('NS-N02: reordering the same revisions cannot erase conflict disclosure',()=>{
 const a=bars[0];
 const b=changed(a,{sequence:a.sequence+1,payload:{close:a.payload.close+1,high:a.payload.high+2}});
 const later=changed(a,{sequence:a.sequence+2,receivedTs:a.receivedTs+1000,knownAtTs:a.knownAtTs+1000,payload:{close:a.payload.close+2,high:a.payload.high+3}});
 assert.ok([a,b,later].every(o=>observationError(o)===null));
 const x=selectNativeSeries([a,b,later]);const y=selectNativeSeries([later,a,b]);
 assert.equal(x.selected[0].observationId,y.selected[0].observationId);
 assert.ok(x.conflicts>=1,'the supplied equal-clock values conflict');
 assert.equal(y.conflicts,x.conflicts,'a later revision arriving first cannot hide the earlier equal-clock conflict');
 assert.equal(y.revisions,x.revisions,'diagnostic counts must not depend on traversal order');
});
test('NS-N03: generated context must disclose a missing interval inside its candle window',()=>{
 const gapped=bars.filter((_,i)=>i!==20);assert.equal(gapped.length,61);
 const c=ctx(gapped);assert.equal(c.error,null,'honest partial context remains representable');
 assert.notEqual(c.support.state,'COMPLETE','sixty-one observed bars do not prove a contiguous sixty-two-period window');
 assert.ok(c.support.reasons.length>0,'state the missing-history limitation');
});
test('NS-N04: the direct indicator recipe cannot pool two venues to satisfy SMA60',()=>{
 const other=bars.slice(31).map(o=>changed(o,{provider:'COINBASE_SPOT',endpointId:'rest-candles',subject:{...o.subject,venue:'coinbase',nativeSymbol:'BTC-USD'},provenance:{...o.provenance,mappingId:'coinbase-market-v1'}}));
 const mixed=[...bars.slice(0,31),...other];assert.ok(mixed.every(o=>observationError(o)===null));
 assert.equal(selectNativeSeries(mixed).seriesCount,2);
 let result,error;try{result=indicators(mixed);}catch(e){error=e;}
 if(error){assert.ok(['INVALID_INPUT','INVALID_REQUEST','VALIDATION_FAILURE'].includes(error.code),'a deliberate incompatible-input rejection, not a TypeError');return;}
 assert.equal(result.sma[60],null,'each venue has only thirty-one bars; there is no sixty-bar single-series SMA');
 assert.notEqual(result.support.state,'COMPLETE');
});
