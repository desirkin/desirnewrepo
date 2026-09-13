// Provider transports for an explicitly approved CURRENT view. No persistence, automatic
// scope expansion, content inference, writes to providers, or social-journal admission.
import { evaluateRedditAccess, redditApprovalRecordFromEnv, redditListingRequest, redditThingToPreview } from './social-reddit.js';
import { evaluateMetaRouteAccess, metaRouteRecordFromEnv } from './social-meta.js';
import { evaluateStocktwitsAccess, stocktwitsAccessRecordFromEnv, firestreamEnvelopeToPreview } from './social-stocktwits.js';
import { currentSocialRecord } from './social-current-store.js';
import { fetchJsonBounded, pinnedUrlError } from '../lib/bounded-fetch.js';
const csv = v => String(v ?? '').split(',').map(s => s.trim()).filter(Boolean);
const scope = (a,re,max=8) => a.length > 0 && a.length <= max && a.every(v => re.test(v)) && new Set(a).size === a.length;
const fail = (reason, delayMs=60000) => ({ ok:false, reason, delayMs });
const clock = v => { const t=typeof v === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:?\d\d)$/.test(v) ? Date.parse(v) : NaN; return Number.isSafeInteger(t) ? t : null; };
const denied = r => fail([401,403].includes(r.status) ? 'CREDENTIAL_REFUSED' : r.reason ?? r.outcome, r.outcome === 'RATE_LIMITED' ? Math.min(86400000, Math.max(60000,(r.retryAfterSec ?? 60)*1000)) : [401,403].includes(r.status) ? 3600000 : 60000);
export function createRedditCurrentClient({ env, now, fetchImpl, record = redditApprovalRecordFromEnv(env) }) {
  const subreddits = csv(env.RUMOR2_SOCIAL_REDDIT_SUBREDDITS), userAgent=env.RUMOR2_SOCIAL_REDDIT_USER_AGENT;
  let token=null, tokenExpires=0, index=0, after=null;
  return { id:'REDDIT_OFFICIAL', lane:'REDDIT_OFFICIAL', capEnv:'RUMOR2_SOCIAL_REDDIT_MAX_DAILY_REQUESTS', enabled:env.RUMOR2_SOCIAL_REDDIT_ENABLED==='true',
    gate() { const a=evaluateRedditAccess({ record, env, nowMs:now() }); if (!a.activationPrerequisitesMet) return a.blockers[0] ?? 'APPROVAL_REQUIRED'; if (!scope(subreddits,/^[A-Za-z0-9_]{2,21}$/) || redditListingRequest({subreddit:subreddits[0],userAgent}).error) return 'SUBREDDIT_SCOPE_AND_USER_AGENT_REQUIRED'; return null; },
    stop() { token=null; tokenExpires=0; after=null; index=0; },
    async poll({ reserve, signal, valid, store }) {
      if (!token || now() >= tokenExpires) {
        if (!await reserve()) return fail('BUDGET_STOPPED');
        const r=await fetchJsonBounded('https://www.reddit.com/api/v1/access_token',{host:'www.reddit.com',method:'POST',fetchImpl,signal,headers:{authorization:`Basic ${Buffer.from(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`).toString('base64')}`,'user-agent':userAgent,'content-type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'});
        if (!valid()) return fail('STOPPED'); if(r.outcome!=='OK') return denied(r);
        if(typeof r.json?.access_token!=='string'||!r.json.access_token||r.json.access_token.length>4096||r.json.token_type?.toLowerCase()!=='bearer'||!Number.isSafeInteger(r.json.expires_in)||r.json.expires_in<60||r.json.expires_in>86400) return fail('TOKEN_RESPONSE_INVALID');
        token=r.json.access_token; tokenExpires=now()+(r.json.expires_in-30)*1000;
      }
      if (!await reserve()) return fail('BUDGET_STOPPED');
      const req=redditListingRequest({subreddit:subreddits[index],after,userAgent,limit:100}); if(req.error) return fail('REQUEST_SCOPE_INVALID');
      const r=await fetchJsonBounded(`https://${req.host}${req.path}?${new URLSearchParams(req.query)}`,{host:req.host,fetchImpl,signal,headers:{authorization:`Bearer ${token}`,'user-agent':userAgent}});
      if(!valid()) return fail('STOPPED'); if(r.outcome!=='OK'){if(r.status===401)token=null;return denied(r);}
      const d=r.json?.data, next=d?.after ?? null;
      if(r.json?.kind!=='Listing'||!Array.isArray(d?.children)||d.children.length>100||(next!==null&&(!/^t[13]_[a-z0-9]{1,20}$/.test(next)||next===after)))return fail('LISTING_INVALID');
      const previews=d.children.map(thing=>redditThingToPreview(thing,{retrievedTs:now()}).preview); if(previews.some(p=>!p))return fail('LISTING_ITEM_INVALID');
      let admitted=0; for(const p of previews){if(p.removal.gone)store.remove('REDDIT_OFFICIAL',p.nativeThingId);else {const o=currentSocialRecord('REDDIT_OFFICIAL',{nativeId:p.nativeThingId,authorId:p.author.nativeAuthorId,text:p.originalText,title:p.title,link:p.canonicalUrl,sourceTs:p.sourceCreatedTs},now());if(o&&store.upsert(o))admitted++;}}
      // Current sampled pages only; rotate at a bounded two-page depth rather than backfill history.
      after=after ? null : next; if(after===null)index=(index+1)%subreddits.length;
      const reset=Number(r.rateHeaders?.['x-ratelimit-reset']),remaining=Number(r.rateHeaders?.['x-ratelimit-remaining']);
      return {ok:true,admitted,coverage:'CURRENT_LISTING_SAMPLE',delayMs:remaining===0&&Number.isFinite(reset)?Math.min(86400000,Math.max(60000,reset*1000)):60000};
    } };
}
export function createMetaCurrentClient({ env, now, fetchImpl, instagram=false, record=null }) {
  const id=instagram?'META_INSTAGRAM':'META_FACEBOOK',route=instagram?'INSTAGRAM_HASHTAG_DISCOVERY':'FACEBOOK_PAGE_PUBLIC_CONTENT';
  const prefix=instagram?'RUMOR2_SOCIAL_INSTAGRAM_':'RUMOR2_SOCIAL_FACEBOOK_';
  const version=env.META_GRAPH_API_VERSION, ids=csv(env[prefix+(instagram?'HASHTAG_IDS':'PAGE_IDS')]);
  // Route attestations are independent; a Facebook approval never opens Instagram.
  record ??= metaRouteRecordFromEnv(Object.fromEntries(Object.entries(env).map(([k,v])=>[k.startsWith(prefix+'ROUTE_')?k.replace(prefix+'ROUTE_','RUMOR2_SOCIAL_META_ROUTE_'):k,v])));
  let index=0, after=null;
  return {id,lane:'META_PUBLIC',capEnv:'RUMOR2_SOCIAL_META_MAX_DAILY_REQUESTS',enabled:env[prefix+'ENABLED']==='true',
    gate(){const a=evaluateMetaRouteAccess({routeId:route,record,env,nowMs:now()});if(!a.activationPrerequisitesMet)return a.blockers[0]??'APP_REVIEW_REQUIRED';if(!/^v\d{1,2}\.\d$/.test(version??'')||!scope(ids,/^\d{1,30}$/,instagram?8:8)||(instagram&&!/^\d{1,30}$/.test(env.META_INSTAGRAM_USER_ID??'')))return 'VERSION_AND_ENTITY_SCOPE_REQUIRED';if(instagram&&env.RUMOR2_SOCIAL_INSTAGRAM_HASHTAG_SCOPE_REVIEW!=='APPROVED_ACCOUNT_7_DAY_CAP')return 'HASHTAG_ACCOUNT_CAP_REVIEW_REQUIRED';return null;},
    stop(){index=0;after=null;},
    async poll({reserve,signal,valid,store}){
      if(!await reserve())return fail('BUDGET_STOPPED');
      const fields=instagram?'id,caption,permalink,timestamp,media_type':'id,message,created_time,permalink_url,from';
      const q=new URLSearchParams({fields,limit:'50',...(after?{after}:{}),...(instagram?{user_id:env.META_INSTAGRAM_USER_ID}:{})});
      const r=await fetchJsonBounded(`https://graph.facebook.com/${version}/${ids[index]}/${instagram?'recent_media':'feed'}?${q}`,{host:'graph.facebook.com',fetchImpl,signal,headers:{authorization:`Bearer ${env.META_APP_TOKEN}`}});
      if(!valid())return fail('STOPPED');if(r.outcome!=='OK'||r.json?.error)return denied({...r,reason:r.json?.error?'GRAPH_API_REFUSED':r.reason});
      const d=r.json, next=d?.paging?.next ? d.paging?.cursors?.after : null;
      if(!Array.isArray(d?.data)||d.data.length>50||(next!=null&&(typeof next!=='string'||!next||next.length>2048||next===after)))return fail('GRAPH_PAGE_INVALID');
      const records=d.data.map(p=> {if(!p||typeof p.id!=='string'||!(instagram?/^\d{1,30}$/:/^\d{1,30}_\d{1,30}$/).test(p.id)||(!instagram&&!p.id.startsWith(ids[index]+'_')))return null;return currentSocialRecord(id,{nativeId:p.id,authorId:instagram?null:p.from?.id??ids[index],text:instagram?p.caption:p.message,link:instagram?p.permalink??null:p.permalink_url??null,sourceTs:clock(instagram?p.timestamp:p.created_time)},now());});
      if(records.some(o=>!o))return fail('GRAPH_ITEM_INVALID');for(const o of records)store.upsert(o);
      after=after?null:next; if(!after)index=(index+1)%ids.length;
      return {ok:true,admitted:records.length,coverage:instagram?'HASHTAG_RECENT_MEDIA_SAMPLE':'PUBLIC_PAGE_FEED_SAMPLE',delayMs:60000};
    } };
}
export function createStocktwitsCurrentClient({env,now,fetchImpl,record=stocktwitsAccessRecordFromEnv(env),windowMs=5000}){
  const symbols=csv(env.RUMOR2_SOCIAL_STOCKTWITS_SYMBOLS); let cursor=null;
  return {id:'STOCKTWITS_OFFICIAL',lane:'STOCKTWITS_OFFICIAL',capEnv:'RUMOR2_SOCIAL_STOCKTWITS_MAX_DAILY_REQUESTS',enabled:env.RUMOR2_SOCIAL_STOCKTWITS_ENABLED==='true',
    gate(){const a=evaluateStocktwitsAccess({record,env,nowMs:now()});if(!a.activationPrerequisitesMet)return a.blockers[0]??'ENTITLEMENT_REQUIRED';if(a.route!=='FIRESTREAM_MESSAGES')return 'MESSAGE_ROUTE_REQUIRED';if(!scope(symbols,/^[A-Za-z0-9._-]{1,32}$/,50))return 'SYMBOL_SCOPE_REQUIRED';if(env.RUMOR2_SOCIAL_STOCKTWITS_ACCESS_COST!=='INCLUDED')return 'PLAN_COST_REVIEW_REQUIRED';return null;},stop(){cursor=null;},
    async poll({reserve,signal,valid,store}){
      if(!await reserve())return fail('BUDGET_STOPPED');
      const url=`https://firestream.stocktwits.com/stream${cursor?`?seq_id=${encodeURIComponent(cursor)}`:''}`;
      if(pinnedUrlError(url,{host:'firestream.stocktwits.com'}))return fail('HOST_REFUSED');
      const ctl=new AbortController();let timedOut=false,connected=false,reader=null,timer,records=0,admitted=0,tail='',bytes=0;
      const stopped=()=>ctl.abort();signal.addEventListener('abort',stopped,{once:true});
      const deadline=new Promise((_,reject)=>{ctl.signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true});timer=setTimeout(()=>{timedOut=true;ctl.abort();},windowMs);});
      const race=p=>Promise.race([p,deadline]);
      try{
        if(signal.aborted||!valid())return fail('STOPPED');
        const response=await race(fetchImpl(url,{redirect:'manual',signal:ctl.signal,headers:{authorization:`Basic ${Buffer.from(`${env.STOCKTWITS_STREAM_USER}:${env.STOCKTWITS_STREAM_PASS}`).toString('base64')}`,accept:'application/json'}}));
        if(!response.ok){response.body?.cancel?.().catch(()=>{});return denied({status:response.status,outcome:response.status===429?'RATE_LIMITED':'FAILED',reason:`HTTP ${response.status}`});}
        if(!response.body?.getReader)return fail('STREAM_BODY_REQUIRED');reader=response.body.getReader();connected=true;const decoder=new TextDecoder('utf-8',{fatal:true});
        while(valid()){
          const {value,done}=await race(reader.read());if(done){tail+=decoder.decode();if(tail.trim())return fail('STREAM_TRUNCATED_FRAME');break;}bytes+=value.byteLength;if(bytes>2097152)return fail('STREAM_WINDOW_BYTE_CAP');tail+=decoder.decode(value,{stream:true});
          for(let nl;(nl=tail.indexOf('\n'))>=0;){const line=tail.slice(0,nl).trim();tail=tail.slice(nl+1);if(!line)continue;if(Buffer.byteLength(line)>65536)return fail('STREAM_LINE_CAP');let e;try{e=JSON.parse(line);}catch{return fail('STREAM_JSON_INVALID');}
            const p=firestreamEnvelopeToPreview(e,{retrievedTs:now()}).preview;
            if(e.object==='Message'&&!p)return fail('STREAM_MESSAGE_INVALID');
            if(p){if(!valid())return fail('STOPPED');if(e.object==='Message'&&e.action==='destroy')store.remove('STOCKTWITS_OFFICIAL',p.nativeMessageId);else if(e.object==='Message'&&e.action==='create'&&Array.isArray(e.data?.symbols)&&e.data.symbols.some(s=>symbols.includes(s.symbol))){const o=currentSocialRecord('STOCKTWITS_OFFICIAL',{nativeId:p.nativeMessageId,authorId:p.author?.nativeAuthorId??null,text:p.originalText,sourceTs:p.sourceCreatedTs},now());if(o&&store.upsert(o))admitted++;}if(p.delivery.seqId)cursor=p.delivery.seqId;}
            records++;if(records>=500)return {ok:true,admitted,coverage:'SAMPLED_STREAM_WINDOW',delayMs:60000};
          }
          if(Buffer.byteLength(tail)>65536)return fail('STREAM_LINE_CAP');
        }
        return {ok:true,admitted,coverage:'SAMPLED_STREAM_WINDOW',delayMs:60000};
      }catch{return timedOut&&connected&&valid()?{ok:true,admitted,coverage:'SAMPLED_STREAM_WINDOW',delayMs:60000}:fail('STREAM_FAILED');}
      finally{clearTimeout(timer);signal.removeEventListener('abort',stopped);ctl.abort();try{Promise.resolve(reader?.cancel()).catch(()=>{});}catch{}try{reader?.releaseLock();}catch{}}
    } };
}
