import { secretEqual } from './core.js';

const PROVIDERS={
  'chatgpt-web':{hostname:'chatgpt.com',path:/^(?:\/g\/g-[a-zA-Z0-9_-]{8,240}|\/g-[a-zA-Z0-9_-]{8,150})?\/c\/([a-zA-Z0-9_-]{8,150})(?:\/|$)/},
  'codex-web':{hostname:'chatgpt.com',path:/^\/codex\/(?:cloud\/)?tasks\/([a-zA-Z0-9_-]{8,150})(?:\/|$)/},
  'deepseek-web':{hostname:'chat.deepseek.com',path:/^\/a\/chat\/s\/([a-zA-Z0-9_-]{8,150})(?:\/|$)/}
};
function providerSession(runtime,url,nativeId){
  const def=PROVIDERS[runtime];
  if(!def||typeof url!=='string'||typeof nativeId!=='string')return false;
  try{
    const u=new URL(url);
    return u.protocol==='https:'&&u.hostname===def.hostname&&u.pathname.match(def.path)?.[1]===nativeId;
  }catch{return false;}
}
const validHost=x=>typeof x==='string'&&/^web-[a-zA-Z0-9_-]{8,45}$/.test(x);
const allowedOrigin=x=>!x||/^chrome-extension:\/\/[a-p]{32}$/.test(x)||/^extension:\/\/[a-zA-Z0-9-]{8,100}$/.test(x);
function respond(res,status,data,origin){
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    ...(origin?{'Access-Control-Allow-Origin':origin,'Vary':'Origin'}:{})
  });
  res.end(JSON.stringify(data));
}
async function readBody(req){
  const chunks=[];let size=0;
  for await(const b of req){size+=b.length;if(size>1024*1024)throw new Error('Request too large');chunks.push(b);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
}

/** Browser-only API; bearer cannot access normal user or native connector endpoints. */
export async function handleBrowserBridge(req,res,url,{store,secrets,notify,broadcast}){
  const origin=req.headers.origin||'';
  if(!allowedOrigin(origin)){
    respond(res,403,{error:'Only installed browser extensions can call the bridge'});
    return;
  }
  if(req.method==='OPTIONS'){
    res.writeHead(204,{
      ...(origin?{'Access-Control-Allow-Origin':origin,'Vary':'Origin'}:{}),
      'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'300'
    });res.end();return;
  }
  if(!secretEqual((req.headers.authorization||'').replace(/^Bearer /i,''),secrets.browserToken)){
    respond(res,401,{error:'Browser extension token invalid: reconnect in extension popup'},origin);return;
  }
  const path=url.pathname;
  try{
    if(path==='/api/browser/ping'&&req.method==='GET'){
      respond(res,200,{ok:true,kind:'attnwall-browser-bridge',version:1},origin);return;
    }
    if(path==='/api/browser/sync'&&req.method==='POST'){
      const data=await readBody(req);
      if(!validHost(data.host)){respond(res,400,{error:'Invalid browser installation ID'},origin);return;}
      // Legacy ChatGPT collectors scanned global search results and could import
      // messages from other conversations. Refuse their writes until upgraded.
      if(data.captureVersion!==2 && (Array.isArray(data.messages)?data.messages:[]).some(m=>m.runtime==='chatgpt-web')){
        respond(res,426,{error:'ChatGPT collector outdated: reload AttnWall Web Bridge v0.3.1+ and refresh your conversation tab.'},origin);
        return;
      }
      let added=0;
      for(const s of (Array.isArray(data.sessions)?data.sessions:[]).slice(0,120)){
        if(!providerSession(s.runtime,s.url,s.nativeId))continue;
        store.session({host:data.host,runtime:s.runtime,nativeId:s.nativeId,
          title:String(s.title||'Web conversation').slice(0,150),status:'idle',sourceUrl:s.url});
      }
      for(const m of (Array.isArray(data.messages)?data.messages:[]).slice(0,60)){
        if(!providerSession(m.runtime,m.url,m.nativeId))continue;
        if(!['agent','user'].includes(m.role)||typeof m.body!=='string'||!m.body.trim()||m.body.length>20000)continue;
        if(typeof m.externalId!=='string'||!/^[a-z0-9_-]{8,130}$/i.test(m.externalId))continue;
        const id=store.session({host:data.host,runtime:m.runtime,nativeId:m.nativeId,
          title:String(m.title||'Web conversation').slice(0,150),status:'idle',sourceUrl:m.url});
        const priority=m.role==='agent'&&store.setting('instantEnabled')&&store.sessionById(id).instant_mode?'instant':'normal';
        const stored=store.message({sessionId:id,externalId:m.externalId,role:m.role,
          body:m.body,priority,runId:typeof m.runId==='string'?m.runId:'',silent:m.silent===true});
        if(stored){
          added++;
          // Intermediate web replies are never notified before run completion.
        }
      }
      for(const c of (Array.isArray(data.completions)?data.completions:[]).slice(0,10)){
        if(!providerSession(c.runtime,c.url,c.nativeId)||typeof c.runId!=='string'||!c.runId.startsWith('web:dom-'))continue;
        const sessionId=data.host+':'+c.runtime+':'+c.nativeId;
        if(!store.sessionById(sessionId))continue;
        const last=store.completeRun(sessionId,c.runId,{status:'completed'});
        if(last?.priority==='instant')void notify.instant({...last,title:store.sessionById(sessionId).title}).catch(console.error);
      }
      if(added||data.sessions?.length||data.completions?.length)broadcast('update',{kind:'browserSync',added});
      respond(res,200,{ok:true,added},origin);return;
    }
    if(path==='/api/browser/jobs'&&req.method==='GET'){
      const host=url.searchParams.get('host');
      if(!validHost(host)){respond(res,400,{error:'Invalid host'},origin);return;}
      const claimed=store.claimReplies(host);
      const jobs=claimed.filter(job=>job.kind==='message'&&['codex-web','deepseek-web','chatgpt-web'].includes(job.runtime))
        .map(job=>({...job,source_url:store.sessionById(job.session_id)?.source_url||''}));
      // Browser token has no capability to drive native runtime jobs.
      const historyRequests=store.claimWebHistory(host);
      respond(res,200,{jobs,historyRequests},origin);return;
    }
    if(path==='/api/browser/history/ack'&&req.method==='POST'){
      const data=await readBody(req);
      if(!validHost(data.host)||typeof data.sessionId!=='string'){
        respond(res,400,{error:'Invalid history report'},origin);return;
      }
      const session=store.sessionById(data.sessionId);
      if(!session||session.host!==data.host||!['chatgpt-web','codex-web','deepseek-web'].includes(session.runtime)){
        respond(res,404,{error:'Unknown history request'},origin);return;
      }
      store.completeHistory(data.sessionId,typeof data.error==='string'?data.error.slice(0,300):null);
      broadcast('update',{kind:'history',sessionId:data.sessionId});
      respond(res,200,{ok:true},origin);return;
    }
    if(path==='/api/browser/attachment'&&req.method==='GET'){
      const host=url.searchParams.get('host'),replyId=url.searchParams.get('replyId');
      if(!validHost(host)||typeof replyId!=='string'){
        respond(res,400,{error:'Invalid image request'},origin);return;
      }
      respond(res,200,{image:store.replyImage(replyId,host)},origin);return;
    }
    if(path==='/api/browser/ack'&&req.method==='POST'){
      const data=await readBody(req);
      if(!validHost(data.host)||!['sent','failed'].includes(data.state)){
        respond(res,400,{error:'Invalid delivery status'},origin);return;
      }
      const row=store.db.prepare('SELECT r.id,s.host,s.runtime FROM replies r JOIN sessions s ON s.id=r.session_id WHERE r.id=?').get(data.id);
      if(!row||row.host!==data.host||!['codex-web','deepseek-web','chatgpt-web'].includes(row.runtime)){
        respond(res,404,{error:'Unknown browser reply'},origin);return;
      }
      store.replyState(data.id,data.state,data.state==='failed'?String(data.error||'Web tab not available').slice(0,400):null);
      broadcast('update',{kind:'replyState'});respond(res,200,{ok:true},origin);return;
    }
    respond(res,404,{error:'Unknown browser bridge endpoint'},origin);
  }catch(e){respond(res,400,{error:e.message||'Browser bridge request failed'},origin);}
}
