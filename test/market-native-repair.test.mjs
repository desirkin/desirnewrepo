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

const {runBuild,readContext}=await imp('market-lab/commands.js');
const {etfFlowSummary}=await imp('market-lab/recipes.js');
test('NP01: every revision permutation has identical facts and earlier as-of excludes future revisions',()=>{
 const a=bars[0],b=changed(a,{sequence:a.sequence+1,payload:{close:101,high:102}}),c=changed(a,{sequence:a.sequence+2,receivedTs:T0+1000,knownAtTs:T0+1000,payload:{close:102,high:103}});
 const sets=[[a,b,c],[a,c,b],[b,a,c],[b,c,a],[c,a,b],[c,b,a]];
 const describe=rows=>{const s=selectNativeSeries(rows);return {selected:s.selected.map(o=>o.observationId),series:s.series,conflicts:s.conflicts,repeats:s.repeats,revisions:s.revisions};};
 for(const rows of sets)assert.deepEqual(describe(rows),describe(sets[0]));
 const early=selectNativeSeries([c,b,a],{asOfTs:T0});assert.equal(early.lateExcluded,1);assert.equal(early.selected[0].knownAtTs,T0);
 assert.equal(early.conflicts,1);assert.equal(early.revisions,0);
});
test('NP02: context preserves separate native venues and each short series stays below SMA60 warmup',()=>{
 const second=bars.slice(31).map(o=>changed(o,{provider:'COINBASE_SPOT',endpointId:'rest-candles',subject:{...o.subject,venue:'coinbase',nativeSymbol:'BTC-USD'}}));
 const observations=[...bars.slice(0,31),...second];assert.ok(observations.every(o=>observationError(o)===null));
 const built=buildContext({canonicalCoin:'BTC',asOfTs:T0,observations,captureRef:SEALED_REF});assert.equal(contextError(built.context),null);
 const comps=built.context.families.SPOT_PRICE_CHART.components.filter(c=>c.metricId==='indicators');assert.equal(comps.length,2);
 for(const c of comps){assert.equal(c.value.closedBars,31);assert.equal(c.value.sma[60],null);}
});
test('NP03: a real gapped capture publishes and reopens an honest partial context',async()=>{
 const dir=tmp('native-gap-publish-');const cap=path.join(dir,'capture'),out=path.join(dir,'context');
 const own=createResearchOwner({policy,subjects:btcOnly(),clock:()=>T0,researchRoot:dir,mode:'INTEGRATED',fetchImpl:async u=>{
  if(new URL(u).pathname.endsWith('AssetPairs'))return json(H.KRAKEN_ASSET_PAIRS);
  const data=H.krakenOhlc('XXBTZUSD',{intervalMin:Number(new URL(u).searchParams.get('interval')??60),endTs:T0,count:63});data.result.XXBTZUSD.splice(20,1);return json(data);
 }});
 try{await own.start({outDir:cap,families:[]});await own.clients.KRAKEN_SPOT.loadCatalog();const market=own.clients.KRAKEN_SPOT.resolveMarket({canonicalCoin:'BTC'}).market;const r=await own.acquire('SPOT_PRICE_CHART','BTC',{metricIds:['sma']});assert.ok(r.observations.some(o=>o.kind==='CANDLE'));await own.stop({seal:true});runBuild({captureDir:cap,asOfTs:T0,canonicalCoin:'BTC',out});const reopened=readContext(out);assert.equal(contextError(reopened.context),null);const c=reopened.context.families.SPOT_PRICE_CHART.components.find(c=>c.metricId==='indicators'&&c.value.intervalMs===3600000);assert.ok(c,'hourly context was recorded');assert.equal(c.support.state,'PARTIAL');assert.ok(c.support.reasons.includes('MISSING_PERIODS'));assert.equal(c.value.sma[60],null);assert.equal(c.inputObservationCount,61);}
 finally{await own.stop({seal:false});rmSync(dir,{recursive:true,force:true});}
});
const envelope=bars[0];
const flow=asset=>{const {observationId,...rest}=envelope;return makeObservation({...rest,provider:'COINGLASS',endpointId:'etf-flow',kind:'ETF_FLOW',sourceKey:asset,subject:{subjectKind:'ASSET',canonicalCoin:asset,providerAssetId:asset},payload:{fund:null,asset,flowUsd:100,reportingPeriodStartTs:rest.periodStartTs,reportingPeriodEndTs:rest.periodEndTs,estimate:false,revision:null,priceUsd:null}});};
test('NP04: ETF arithmetic refuses mixed aggregate series while a single asset keeps its own flow',()=>{
 const btc=flow('BTC'),eth=flow('ETH');assert.equal(observationError(btc),null);assert.equal(observationError(eth),null);
 assert.equal(etfFlowSummary([btc,structuredClone(btc)]).trailing5,100);
 assert.throws(()=>etfFlowSummary([btc,eth]),e=>e.code==='INVALID_REQUEST');
 const built=buildContext({canonicalCoin:'BTC',asOfTs:T0,observations:[btc,eth],captureRef:SEALED_REF});assert.equal(contextError(built.context),null);const c=built.context.families.ETF_FLOWS.components[0];assert.equal(c.value.latest.flowUsd,100);assert.equal(c.inputObservationCount,1);
});
test('NP05: cross-asset contexts do not turn two exchanges into a synthetic two-bar return',()=>{
 const cross=(o,exchange,price)=>{const {observationId,...rest}=o;return makeObservation({...rest,provider:'TWELVEDATA',endpointId:'time-series',kind:'CROSS_ASSET_BAR',sourceKey:exchange,subject:{subjectKind:'SERIES',canonicalCoin:null,providerAssetId:null,seriesId:null,instrumentId:'SPY'},payload:{instrument:'SPY',exchange,intervalMs:3600000,open:price,high:price,low:price,close:price,volume:100,sessionState:'UNKNOWN',delayed:false,proxyFor:null,currency:'USD'}});};
 const observations=[cross(bars[0],'NYSE',100),cross(bars[1],'NASDAQ',200)];assert.ok(observations.every(o=>observationError(o)===null));
 const built=buildContext({canonicalCoin:'BTC',asOfTs:T0,observations,captureRef:SEALED_REF});assert.equal(contextError(built.context),null);const comps=built.context.families.CROSS_ASSET.components;assert.equal(comps.length,2);for(const c of comps){assert.equal(c.value.logReturnLastBar,null);assert.equal(c.support.state,'PARTIAL');}
});
