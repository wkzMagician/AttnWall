/* One content script per supported site. Runs in extension isolated world. */
(() => {
  'use strict';
  const dom=globalThis.AttnWallBridgeDOM;
  if(!dom)return;
  let route='', seen=new Set(),initial=true, busy=false,lastError='',lastOK=0;
  let lastSnapshot='',lastChange=0,lastSidebarAt=0;
  let previousNodes=[],carriedNodes=new Set(),seenRunning=new Set(),completedRuns=new Set();
  let baselineRuns=null;
  let runStarts=new Map(),sentStarts=new Set(),finishedAt=new Map(),lastRun='',sendingStarts=false;
  async function send(message){
    try{return await chrome.runtime.sendMessage(message);}
    catch(e){return {ok:false,error:e.message};}
  }
  function current(){return dom.identify(location.href);}
  function capture(){
    const info=current();
    const key=info?.runtime+':'+info?.nativeId;
    if(route!==key){
      // A SPA URL can change before React removes the previous conversation.
      // Never attach prior-route DOM messages to the new conversation ID.
      carriedNodes=new Set(previousNodes);
      route=key;seen=new Set();seenRunning=new Set();completedRuns=new Set();initial=true;lastSnapshot='';lastChange=Date.now();lastSidebarAt=0;
      baselineRuns=null;runStarts=new Map();sentStarts=new Set();finishedAt=new Map();lastRun='';
    }
    if(!info)return {info,ready:false,messages:[]};
    const nodes=dom.messageNodes(document,info);
    // Identical text in different conversations is fine; retained SPA nodes are not.
    // History reads, delivery probes and live collection must use the same guard.
    if(nodes.some(node=>carriedNodes.has(node)))return {info,ready:false,messages:[]};
    carriedNodes.clear();previousNodes=nodes;
    return {info,ready:true,messages:dom.extract(document,info)};
  }
  function recordStart(info,runId){
    if(!runId||completedRuns.has(runId))return;
    if(!runStarts.has(runId))runStarts.set(runId,Date.now());
    void reportStarts(info);
  }
  async function reportStarts(info){
    if(sendingStarts)return;
    const key=info.runtime+':'+info.nativeId;
    const starts=[...runStarts].filter(([id])=>!sentStarts.has(id)).map(([runId,at])=>({...info,runId,at}));
    if(!starts.length)return;
    sendingStarts=true;
    try{
      const result=await send({type:'ATTNWALL_SYNC',session:{...info,title:document.title.slice(0,150)||info.runtime},messages:[],starts,completions:[]});
      if(result?.ok&&route===key)for(const start of starts)sentStarts.add(start.runId);
    }finally{sendingStarts=false;}
  }
  async function sync(){
    const captured=capture(),info=captured.info;
    if(!captured.ready)return;
    const key=info.runtime+':'+info.nativeId;
    const extracted=captured.messages;
    // Group all assistant messages after the same user turn under one stable run key.
    let activeRun=lastRun;
    for(const m of extracted){
      if(m.role==='user')activeRun='web:'+m.externalId;
      m.runId=activeRun;
    }
    const generating=dom.isGenerating(document,info);
    lastRun=activeRun;
    if(generating&&activeRun){seenRunning.add(activeRun);recordStart(info,activeRun);}
    if(activeRun&&baselineRuns&&!baselineRuns.has(activeRun))recordStart(info,activeRun);
    if(!generating&&activeRun&&(seenRunning.has(activeRun)||extracted.at(-1)?.completed)&&!finishedAt.has(activeRun))finishedAt.set(activeRun,Date.now());
    const snapshot=extracted.map(x=>x.externalId).join(';');
    if(snapshot!==lastSnapshot){lastSnapshot=snapshot;lastChange=Date.now();}
    // Do not report partial streamed assistant messages as independent replies.
    if(Date.now()-lastChange<2600)return;
    if(busy)return;
    if(baselineRuns===null)baselineRuns=new Set(extracted.filter(m=>m.role==='user').map(m=>'web:'+m.externalId));
    busy=true;
    try{
      const lastAssistant=[...extracted].reverse().find(x=>x.role==='agent');
      const unsent=extracted.filter(x=>!seen.has(x.externalId)&&!(generating&&x===lastAssistant));
      const fresh=unsent.slice(0,50);
      const scan=Date.now()-lastSidebarAt>45000;
      const sidebar=scan?dom.discover(document,info):[];
      // A terminal state on a new turn also covers replies whose entire
      // generation happened between observations. Idle text alone is insufficient.
      const explicitComplete=lastAssistant?.completed&&!baselineRuns.has(activeRun);
      const complete= !generating&&activeRun&&(seenRunning.has(activeRun)||explicitComplete)&&
        !unsent.slice(fresh.length).some(m=>m.runId===activeRun)&&
        !completedRuns.has(activeRun)&&extracted.at(-1)?.role==='agent'&&lastAssistant?.runId===activeRun;
      const completions=complete?[{...info,runId:activeRun,status:'completed',at:finishedAt.get(activeRun)||Date.now()}]:[];
      const result=await send({type:'ATTNWALL_SYNC',session:{
        ...info,title:document.title.slice(0,150)||info.runtime,
      },sidebar,messages:fresh.map(x=>({...x,silent:initial&&(!x.runId||baselineRuns.has(x.runId))&&!seenRunning.has(x.runId)})),starts:[...runStarts].filter(([id])=>!sentStarts.has(id)).map(([runId,at])=>({...info,runId,at})),completions});
      if(key!==route)return;
      if(result?.ok){
        for(const m of fresh)seen.add(m.externalId);
        for(const c of completions)completedRuns.add(c.runId);
        initial=initial&&unsent.length>fresh.length;lastOK=Date.now();lastError='';if(scan)lastSidebarAt=Date.now();
        await send({type:'ATTNWALL_POLL'});
      }else lastError=result?.error||'Not paired';
    }finally{busy=false;}
  }
  chrome.runtime.onMessage.addListener((request,_sender,respond)=>{
    if(request?.type==='ATTNWALL_PROBE'){
      const captured=capture(),info=captured.info;
      const matches=!!info&&info.runtime===request.runtime&&info.nativeId===request.nativeId;
      respond({ok:matches,ready:matches&&captured.ready&&!!dom.composer(document)});
      return;
    }
    if(request?.type==='ATTNWALL_CAPTURE'){
      const captured=capture(),info=captured.info;
      if(!info||info.runtime!==request.runtime||info.nativeId!==request.nativeId){
        respond({ok:false,error:'Conversation changed while loading history'});return;
      }
      if(!captured.ready){respond({ok:false,error:AttnWallExtensionI18n.t('原网页正在切换会话，等待历史内容加载')});return;}
      const messages=captured.messages;
      respond({ok:true,messages,title:document.title.slice(0,150)});
      return;
    }
    if(request?.type!=='ATTNWALL_DELIVER')return;
    (async()=>{
      const captured=capture(),info=captured.info;
      if(!info || info.runtime!==request.runtime||info.nativeId!==request.nativeId)
        throw new Error('Active tab does not match target original conversation');
      if(!captured.ready)throw new Error(AttnWallExtensionI18n.t('原网页正在切换会话，尚未发送'));
      return dom.send(document,info,request.text||'',{image:request.image||null});
    })().then(value=>respond({ok:true,...value}),e=>respond({ok:false,error:e.message}));
    return true;
  });
  // Poll content and replies while the tab is actually open.
  setInterval(()=>void sync(),3500);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void sync();});
  function rememberRunning(){
    // Record short generation bursts immediately; a whole reply can finish between polls.
    const info=current();
    if(!info||!dom.isGenerating(document,info))return;
    const captured=capture();
    if(captured.ready){
      const user=[...captured.messages].reverse().find(message=>message.role==='user');
      const runId=user?'web:'+user.externalId:lastRun;
      if(runId){seenRunning.add(runId);recordStart(info,runId);}
    }
  }
  const observer=new MutationObserver(()=>{
    rememberRunning();
    if(!busy&&Date.now()-lastChange>2000)void sync();
  });
  observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['disabled','aria-label','data-testid','class','data-talvt-turn-state']});
  rememberRunning();
  setTimeout(()=>void sync(),900);
})();
