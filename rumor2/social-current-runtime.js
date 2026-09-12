// S04/S05/S07/S08: one writer-controlled, erasable current view. The journal contains
// only anonymous request counts, so request caps survive restart without retaining posts.
import { createCurrentSocialStore } from './social-current-store.js';
import { createRedditCurrentClient, createMetaCurrentClient, createStocktwitsCurrentClient } from './social-current-clients.js';
import { CURRENT_REQUEST_TYPE, currentRequestEvent, currentRequestError } from './social-current-meter.js';
export function createSocialCurrentRuntime({ env=process.env, now=Date.now, fetchImpl=fetch, records={}, streamWindowMs=5000 }={}) {
  const store=createCurrentSocialStore({now}); const clients=[createRedditCurrentClient({env,now,fetchImpl,record:records.reddit}),createStocktwitsCurrentClient({env,now,fetchImpl,record:records.stocktwits,windowMs:streamWindowMs}),createMetaCurrentClient({env,now,fetchImpl,record:records.facebook}),createMetaCurrentClient({env,now,fetchImpl,instagram:true,record:records.instagram})];
  const states=new Map(clients.map(c=>[c.id,{state:c.enabled?'NOT_OBSERVED':'DISABLED',nextAt:0,lastSuccessTs:null,lastError:null,coverage:'NOT_OBSERVED',requests:0}]));
  let active=false, hydrated=false, inFlight=false, ctl=null, generation=0, counts={}, meterDay=new Date(now()).toISOString().slice(0,10), pending=null;
  function stop(){generation++;active=false;ctl?.abort();store.clear();for(const c of clients)c.stop();}
  function hydrate(events){stop();counts={};pending=null;meterDay=new Date(now()).toISOString().slice(0,10);for(const e of events)if(e?.type===CURRENT_REQUEST_TYPE){const err=currentRequestError(e);if(err)return {ok:false,error:err};if(e.day===meterDay)counts[e.provider]=Math.max(counts[e.provider]??0,e.ordinal);}hydrated=true;return {ok:true};}
  function gate(c){if(!c.enabled)return 'DISABLED';const cap=Number(env[c.capEnv]);if(!Number.isInteger(cap)||cap<1||cap>10000)return 'REQUEST_BUDGET_REQUIRED';return c.gate();}
  function start(){if(!hydrated)return {ok:false,reason:'NOT_HYDRATED'};active=true;return {ok:true};}
  async function settle({fenceHeld=()=>false,append}){
    if(inFlight||!active)return {ok:true,idle:true};if(!fenceHeld()){stop();return {ok:false,reason:'WRITER_FENCE_LOST'};}
    inFlight=true;const gen=generation,committed=[];let lastSeq;
    const valid=()=>active&&generation===gen&&fenceHeld();
    try{
      const day=new Date(now()).toISOString().slice(0,10);if(day!==meterDay){meterDay=day;counts={};pending=null;}
      // Recover an uncertain acknowledgement even if its provider has since been disabled.
      // Only anonymous accounting is retried here; no content or provider request is replayed.
      const commitPending=async()=>{
        if(!pending||!valid())return !pending;
        const r=await append([pending]);if(!r?.ok||!valid())return false;
        committed.push(pending);lastSeq=r.lastSeq;counts[pending.provider]=Math.max(counts[pending.provider]??0,pending.ordinal);pending=null;return true;
      };
      if(pending&&!await commitPending())return {ok:false,reason:'REQUEST_RESERVATION_UNACKNOWLEDGED'};
      for(const c of clients){const st=states.get(c.id),blocked=gate(c);if(blocked){st.state=blocked;store.clear(c.id);c.stop();continue;}if(now()<st.nextAt)continue;
        ctl=new AbortController();
        let reservationError=null;
        const reserve=async()=>{
          if(!valid())return false;const cap=Number(env[c.capEnv]);if((counts[c.lane]??0)>=cap)return false;
          // A failed acknowledgement retains the exact operation; no second ordinal is minted.
          pending??=currentRequestEvent(c.lane,meterDay,(counts[c.lane]??0)+1,now());
          if(pending.provider!==c.lane)return false;
          if(!await commitPending()){reservationError='REQUEST_RESERVATION_UNACKNOWLEDGED';return false;}
          st.requests++;return true;
        };
        const result=await c.poll({reserve,signal:ctl.signal,valid,store});if(reservationError)result.reason=reservationError;if(!valid()){stop();return {ok:false,reason:'WRITER_FENCE_LOST'};}
        st.nextAt=now()+Math.max(60000,Math.min(86400000,result.delayMs??60000));st.state=result.ok?(result.admitted?'OBSERVED':'CONNECTED_NO_MATCH'):result.reason;st.lastError=result.ok?null:result.reason;
        if(result.ok){st.lastSuccessTs=now();st.coverage=result.coverage;}else if(result.reason==='CREDENTIAL_REFUSED'){store.clear(c.id);c.stop();}
        ctl=null;
        if(pending)break; // unresolved budget append blocks further calls, retry exact bytes next tick
      }
      return {ok:true,events:committed,appended:committed.length,...(lastSeq===undefined?{}:{lastSeq})};
    }catch{ return committed.length?{ok:false,reason:'CURRENT_COLLECTION_FAILED',committed:{events:committed,lastSeq}}:{ok:false,reason:'CURRENT_COLLECTION_FAILED'}; }
    finally{ctl?.abort();ctl=null;inFlight=false;}
  }
  return {provider:{id:'SOCIAL_CURRENT'},hydrate,start,stop,settle,isActive:()=>active,
    snapshot:()=>store.snapshot(),
    status:()=>({enabled:true,state:active?'CURRENT_VIEW':'DARK',authority:'NONE',retention:'RAM_ONLY_MAX_5_MINUTES',sources:Object.fromEntries(clients.map(c=>{const s=states.get(c.id),blocked=gate(c);const fresh=Number.isSafeInteger(s.lastSuccessTs)&&s.lastSuccessTs<=now()&&now()-s.lastSuccessTs<=300000;return [c.id,{...s,enabled:c.enabled,gateReason:blocked,state:blocked??(!active?'DARK':['OBSERVED','CONNECTED_NO_MATCH'].includes(s.state)&&!fresh?'STALE':s.state)}];})),quota:{day:meterDay,requests:{...counts}}})};
}
