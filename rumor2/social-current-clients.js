// Provider transports for an explicitly approved CURRENT view. No persistence, automatic
// scope expansion, content inference, writes to providers, or social-journal admission.
// LEAN PASS 4a retired the Meta (Facebook/Instagram) and StockTwits-official current clients with their providers; the
// Reddit current client is the one kept CURRENT-view transport.
import { evaluateRedditAccess, redditApprovalRecordFromEnv, redditListingRequest, redditThingToPreview } from './social-reddit.js';
import { currentSocialRecord } from './social-current-store.js';
import { fetchJsonBounded } from '../lib/bounded-fetch.js';
const csv = v => String(v ?? '').split(',').map(s => s.trim()).filter(Boolean);
const scope = (a,re,max=8) => a.length > 0 && a.length <= max && a.every(v => re.test(v)) && new Set(a).size === a.length;
const fail = (reason, delayMs=60000) => ({ ok:false, reason, delayMs });
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
