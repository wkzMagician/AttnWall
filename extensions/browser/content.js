/* One content script per supported site. Runs in extension isolated world. */
(() => {
  'use strict';
  const dom=globalThis.AttnWallBridgeDOM;
  if(!dom)return;
  let route='', seen=new Set(),initial=true, busy=false,lastError='',lastOK=0;
  let lastSnapshot='',lastChange=0,lastSidebarAt=0;
  let previousNodes=[],carriedNodes=new Set(),seenRunning=new Set(),completedRuns=new Set();
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
    }
    if(!info)return {info,ready:false,messages:[]};
    const nodes=dom.messageNodes(document,info);
    // Identical text in different conversations is fine; retained SPA nodes are not.
    // History reads, delivery probes and live collection must use the same guard.
    if(nodes.some(node=>carriedNodes.has(node)))return {info,ready:false,messages:[]};
    carriedNodes.clear();previousNodes=nodes;
    return {info,ready:true,messages:dom.extract(document,info)};
  }
  async function sync(){
    const captured=capture(),info=captured.info;
    if(!captured.ready)return;
    const key=info.runtime+':'+info.nativeId;
    const extracted=captured.messages;
    // Group all assistant messages after the same user turn under one stable run key.
    let activeRun='';
    for(const m of extracted){
      if(m.role==='user')activeRun='web:'+m.externalId;
      m.runId=activeRun;
    }
    const generating=dom.isGenerating(document,info);
    if(generating&&activeRun)seenRunning.add(activeRun);
    const snapshot=extracted.map(x=>x.externalId).join(';');
    if(snapshot!==lastSnapshot){lastSnapshot=snapshot;lastChange=Date.now();}
    // Do not report partial streamed assistant messages as independent replies.
    if(Date.now()-lastChange<2600)return;
    if(busy)return;
    busy=true;
    try{
      const lastAssistant=[...extracted].reverse().find(x=>x.role==='agent');
      const unsent=extracted.filter(x=>!seen.has(x.externalId)&&!(generating&&x===lastAssistant));
      const fresh=unsent.slice(0,50);
      const scan=Date.now()-lastSidebarAt>45000;
      const sidebar=scan?dom.discover(document,info):[];
      // Only a witnessed running -> finished transition is a completion signal.
      // Inactive DOM alone is not proof a run has finished.
      const complete= !initial&&!generating&&activeRun&&seenRunning.has(activeRun)&&
        !completedRuns.has(activeRun)&&extracted.at(-1)?.role==='agent'&&lastAssistant?.runId===activeRun;
      const completions=complete?[{...info,runId:activeRun,status:'completed'}]:[];
      const result=await send({type:'ATTNWALL_SYNC',session:{
        ...info,title:document.title.slice(0,150)||info.runtime,
      },sidebar,messages:fresh.map(x=>({...x,silent:initial})),completions});
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
      if(!captured.ready){respond({ok:false,error:'原网页正在切换会话，等待历史内容加载'});return;}
      const messages=captured.messages;
      respond({ok:true,messages,title:document.title.slice(0,150)});
      return;
    }
    if(request?.type!=='ATTNWALL_DELIVER')return;
    (async()=>{
      const captured=capture(),info=captured.info;
      if(!info || info.runtime!==request.runtime||info.nativeId!==request.nativeId)
        throw new Error('Active tab does not match target original conversation');
      if(!captured.ready)throw new Error('原网页正在切换会话，尚未发送');
      return dom.send(document,info,request.text||'',{image:request.image||null});
    })().then(value=>respond({ok:true,...value}),e=>respond({ok:false,error:e.message}));
    return true;
  });
  // Poll content and replies while the tab is actually open.
  setInterval(()=>void sync(),3500);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void sync();});
  const observer=new MutationObserver(()=>{if(!busy&&Date.now()-lastChange>2000)void sync();});
  observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true});
  setTimeout(()=>void sync(),900);
})();
