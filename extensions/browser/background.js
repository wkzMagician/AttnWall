/* MV3 service worker: only this context knows the AttnWall bridge token. */
const tracked=new Map();
let polling=false;
function route(raw){
  try{
    const u=new URL(raw);
    if(u.protocol!=='https:')return null;
    if(u.hostname==='chat.deepseek.com'){
      const m=u.pathname.match(/^\/a\/chat\/s\/([a-zA-Z0-9_-]{8,150})(?:\/|$)/);
      if(m)return {runtime:'deepseek-web',nativeId:m[1],url:u.origin+u.pathname};
    }
    if(u.hostname==='chatgpt.com'){
      const chat=u.pathname.match(/^(?:\/g\/g-[a-zA-Z0-9_-]{8,240}|\/g-[a-zA-Z0-9_-]{8,150})?\/c\/([a-zA-Z0-9_-]{8,150})(?:\/|$)/);
      if(chat)return {runtime:'chatgpt-web',nativeId:chat[1],url:u.origin+u.pathname};
      const m=u.pathname.match(/^\/codex\/(?:cloud\/)?tasks\/([a-zA-Z0-9_-]{8,150})(?:\/|$)/);
      if(m)return {runtime:'codex-web',nativeId:m[1],url:u.origin+u.pathname};
    }
  }catch{}
  return null;
}
async function config(){
  const s=await chrome.storage.local.get(['hub','key','deviceId','enabled']);
  if(!s.deviceId){
    s.deviceId=crypto.randomUUID().replaceAll('-','').slice(0,24);
    await chrome.storage.local.set({deviceId:s.deviceId});
  }
  return {...s,host:'web-'+s.deviceId};
}
async function api(method,path,body){
  const s=await config();
  if(!s.enabled||!s.hub||!s.key)throw new Error('请先在扩展弹窗中连接 AttnWall');
  const resp=await fetch(s.hub+path,{method,
    headers:{'Authorization':'Bearer '+s.key,'Content-Type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const data=await resp.json().catch(()=>({error:'Invalid hub response'}));
  if(!resp.ok)throw new Error(data.error||'Hub HTTP '+resp.status);
  return data;
}
async function report(error='',extra={}){
  await chrome.storage.local.set({bridgeStatus:{error:String(error).slice(0,260),
    at:Date.now(),...extra}});
}
async function sync(request,sender){
  const actual=route(sender.tab?.url);
  if(!actual||request.session?.runtime!==actual.runtime||request.session?.nativeId!==actual.nativeId)
    throw new Error('Only supported ChatGPT, Codex Web or DeepSeek Web conversations can sync');
  if(sender.tab?.id===undefined)throw new Error('No source browser tab');
  const s=await config();
  const sidebar=(Array.isArray(request.sidebar)?request.sidebar:[]).slice(0,100)
    .filter(x=>{const parsed=route(x.url);return parsed&&parsed.runtime===actual.runtime&&parsed.nativeId===x.nativeId;})
    .map(x=>({...route(x.url),title:String(x.title||'Web conversation').slice(0,150)}));
  const messages=(Array.isArray(request.messages)?request.messages:[]).slice(0,50).map(m=>({
    ...actual,role:m.role,body:m.body,externalId:m.externalId,runId:m.runId||'',silent:m.silent===true,
    title:request.session?.title||sender.tab.title||actual.runtime
  }));
  const response=await api('POST','/api/browser/sync',{host:s.host,captureVersion:2,
    sessions:[{...actual,title:(request.session?.title||sender.tab.title||actual.runtime).slice(0,150)},...sidebar],
    messages,starts:(Array.isArray(request.starts)?request.starts:[]).filter(r=>
      r.runtime===actual.runtime&&r.nativeId===actual.nativeId&&typeof r.runId==='string'&&r.runId.startsWith('web:dom-')).slice(0,5).map(r=>({...actual,runId:r.runId,at:r.at,title:request.session?.title||actual.nativeId})),
    completions:(Array.isArray(request.completions)?request.completions:[]).filter(c=>
      c.runtime===actual.runtime&&c.nativeId===actual.nativeId&&
      typeof c.runId==='string'&&c.runId.startsWith('web:dom-')).slice(0,5)});
  tracked.set(sender.tab.id,{...actual,tabId:sender.tab.id,lastSeen:Date.now()});
  await report('',{lastSyncedAt:Date.now(),lastRuntime:actual.runtime,lastTitle:sender.tab.title||''});
  return response;
}
async function targetTab(job){
  const tabs=await chrome.tabs.query({});
  const found=tabs.filter(tab=>{
    const parsed=route(tab.url);
    return parsed&&parsed.runtime===job.runtime&&parsed.nativeId===job.native_id;
  });
  if(found.length){
    const recent=found.sort((a,b)=>(b.lastAccessed||0)-(a.lastAccessed||0))[0];
    return {id:recent.id,opened:false};
  }
  const exact=route(job.source_url);
  if(!exact||exact.runtime!==job.runtime||exact.nativeId!==job.native_id)
    throw new Error('会话地址尚未被扩展发现。请先在原网站打开该会话或从网站侧栏进入，然后重试。');
  // A reply from the user authorizes opening this previously discovered exact conversation.
  const created=await chrome.tabs.create({url:'about:blank',active:false});
  if(created.id===undefined)throw new Error('Unable to open original browser conversation');
  await chrome.tabs.update(created.id,{url:exact.url});
  return {id:created.id,opened:true};
}
async function dispatch(target,job){
  let ready=false;
  for(let attempt=0;attempt<36;attempt++){
    try{
      const check=await chrome.tabs.sendMessage(target.id,{type:'ATTNWALL_PROBE',
        runtime:job.runtime,nativeId:job.native_id});
      if(check?.ok&&check.ready){ready=true;break;}
      if(check?.ok===false)throw new Error('Original conversation ID did not match target tab');
    }catch(e){
      if(!/Receiving end does not exist|Could not establish connection/i.test(e.message||''))throw e;
    }
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  if(!ready)throw new Error('Original conversation is open but its editor is not ready; retry after loading the page');
  // Submit precisely once after a successful non-mutating readiness probe.
  let image=null;
  if(job.attachment_id){
    const s=await config();
    const r=await api('GET','/api/browser/attachment?host='+encodeURIComponent(s.host)+'&replyId='+encodeURIComponent(job.id));
    image=r.image;
  }
  const result=await chrome.tabs.sendMessage(target.id,{type:'ATTNWALL_DELIVER',
    runtime:job.runtime,nativeId:job.native_id,text:job.text,image});
  if(!result?.ok||!result?.sent)throw new Error(result?.error||'Web submission was not verified');
}
async function loadHistory(request,s){
  let error=null;
  try{
    const t=await targetTab({...request,source_url:request.source_url});
    let messages=null, title=request.native_id;
    for(let i=0;i<55;i++){
      try{
        const r=await chrome.tabs.sendMessage(t.id,{type:'ATTNWALL_CAPTURE',runtime:request.runtime,nativeId:request.native_id});
        if(r?.ok&&r.messages?.length){messages=r.messages.slice(-5);title=r.title||title;break;}
      }catch{}
      await new Promise(r=>setTimeout(r,400));
    }
    if(!messages)throw new Error('网页未加载可识别的历史消息。请在原网页打开此会话，并检查扩展是否启用。');
    const url=route(request.source_url)?.url;
    if(!url)throw new Error('Unknown source URL');
    // Mark the backfilled history as already read, never notify about old messages.
    for(let i=0;i<messages.length;i+=30){
      await api('POST','/api/browser/sync',{host:s.host,captureVersion:2,
        sessions:[{runtime:request.runtime,nativeId:request.native_id,url,title}],
        messages:messages.slice(i,i+30).map(m=>({...m,runtime:request.runtime,nativeId:request.native_id,url,title,silent:true}))});
    }
  }catch(e){error=e.message||'Unable to read original webpage';}
  await api('POST','/api/browser/history/ack',{host:s.host,sessionId:request.session_id,error});
}
async function poll(){
  if(polling)return;
  polling=true;
  try{
    const s=await config();
    if(!s.enabled||!s.key||!s.hub)return;
    const {jobs,historyRequests}=await api('GET','/api/browser/jobs?host='+encodeURIComponent(s.host));
    for(const request of historyRequests||[])await loadHistory(request,s);
    for(const job of jobs||[]){
      let state='sent',error='';
      try{const target=await targetTab(job);await dispatch(target,job);}
      catch(e){state='failed';error=e.message;}
      await api('POST','/api/browser/ack',{host:s.host,id:job.id,state,error});
    }
    if((jobs||[]).length)await report('',{lastDeliveryAt:Date.now()});
  }catch(e){await report(e.message);}
  finally{polling=false;}
}
chrome.runtime.onMessage.addListener((request,sender,respond)=>{
  if(!request||!['ATTNWALL_SYNC','ATTNWALL_POLL','ATTNWALL_PING','ATTNWALL_CHECK'].includes(request.type))
    return;
  (async()=>{
    if(request.type==='ATTNWALL_PING')return {ok:true};
    if(request.type==='ATTNWALL_CHECK')return api('GET','/api/browser/ping');
    if(!sender.tab?.id)throw new Error('Only browser content scripts may request synchronization');
    if(request.type==='ATTNWALL_SYNC')return await sync(request,sender);
    await poll();return {ok:true};
  })().then(value=>respond({ok:true,...value}),async error=>{
    await report(error.message);
    respond({ok:false,error:error.message});
  });
  return true;
});
chrome.tabs.onRemoved.addListener(tabId=>tracked.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId,change)=>{
  if(change.url){
    const next=route(change.url),prior=tracked.get(tabId);
    if(prior&&(!next||next.runtime!==prior.runtime||next.nativeId!==prior.nativeId))
      tracked.delete(tabId);
  }
});
chrome.runtime.onInstalled.addListener(()=>{
  void config();
  chrome.alarms.create('attnwall-poll',{periodInMinutes:0.5});
});
chrome.runtime.onStartup.addListener(()=>{
  chrome.alarms.create('attnwall-poll',{periodInMinutes:0.5});
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='attnwall-poll')void poll();});
// Service workers can restart: alarms and chrome.tabs.query are the durable recovery path.
chrome.alarms.create('attnwall-poll',{periodInMinutes:0.5});
