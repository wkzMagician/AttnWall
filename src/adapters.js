import { randomUUID } from 'node:crypto';
import { RpcProcess } from './rpc.js';
import { queueCodexMessage } from './codex-queue.js';
export function extractText(content) {
  if(typeof content==='string') return content;
  if(Array.isArray(content)) return content.map(x=>x.text||x.value||'').join('\n');
  return '';
}
export class CodexAdapter {
  constructor(onMessage=()=>{},onSession=()=>{},onComplete=()=>{}) {
    this.onMessage=onMessage;this.onSession=onSession;this.onComplete=onComplete;
    this.rpc=new RpcProcess(process.env.CODEX_BIN||'codex',['app-server','--listen','stdio://']);
    this.ready=false;this.lastSeen=new Set();this.unsupported=new Set();this.pendingApprovals=new Map();
    this.queuedThreads=new Map();
    this.queuePrompt=(nativeId,text)=>queueCodexMessage(nativeId,text,{executable:process.env.CODEX_QUEUE_BIN||this.rpc.executable,env:this.rpc.options.env||process.env,cwd:this.rpc.options.cwd||process.cwd()});
    this.rpc.on('request',frame=>{
      const p=frame.params||{};
      // NEVER auto-grant an approval; it requires explicit operator action.
      const sid=p.threadId;
      if(!sid) return;
      const key=randomUUID();
      this.pendingApprovals.set(key,frame);
      this.onMessage({runtime:'codex',nativeId:sid,externalId:'approval:'+key,kind:frame.method.includes('requestApproval')?'approval':'userInput',priority:'instant',
        body:'需要人工批准：'+(p.command||p.reason||frame.method),approvalKey:key});
    });
    this.rpc.on('notification',(method,p)=>{
      if(method==='item/completed'&&p.item?.type==='agentMessage')this.ingestItem(p.threadId,p.turnId,p.item);
      if(method==='turn/completed'){
        this.onSession({runtime:'codex',nativeId:p.threadId,status:'idle'});
        const runId=p.turnId||p.turn?.id;
        if(p.threadId&&runId)this.onComplete({runtime:'codex',nativeId:p.threadId,runId:String(runId),status:p.turn?.status==='failed'?'failed':'completed'});
      }
      if(method==='turn/started')this.onSession({runtime:'codex',nativeId:p.threadId,status:'active'});
    });
    this.rpc.on('disconnected',()=>{this.ready=false;});
  }
  async start(){
    if(this.ready)return;
    if(this.starting)return this.starting;
    this.starting=(async()=>{
      await this.rpc.start();
      await this.rpc.request('initialize',{clientInfo:{name:'attnwall',title:'AttnWall',version:'0.1.0'}});
      this.rpc.notify('initialized');
      this.ready=true;
    })();
    try{await this.starting;}finally{this.starting=null;}
  }
  ingestItem(nativeId,turnId,item,silent=false) {
    if(!nativeId||!item?.text)return;
    this.onMessage({runtime:'codex',nativeId,externalId:'turn:'+turnId+':'+item.id,
      body:item.text,priority:'normal',runId:String(turnId||''),silent});
  }
  async sync(){
    if(!this.ready) await this.start();
    let cursor=null;let total=0;
    do{
      const result=await this.rpc.request('thread/list',{cursor,limit:100,sortKey:'updated_at'});
      for(const thread of result.data||[]){
        if(!thread.id)continue;
        const newThread=!this.lastSeen.has(thread.id);
        this.onSession({runtime:'codex',nativeId:thread.id,title:thread.name||thread.preview||'Codex thread',
          cwd:thread.cwd||'',status:this.unsupported.has(thread.id)?'incompatible':this.queuedThreads.has(thread.id)||thread.status?.type==='active'?'active':'idle',updatedAt:Date.now(),activityAt:(thread.updatedAt||thread.createdAt||0)*1000});
        if(!this.unsupported.has(thread.id)&&total<3&&!this.queuedThreads.has(thread.id)){
          try{
            const read=await this.readRecent(thread.id);
            for(const turn of read.turns||[])if(turn.status!=='inProgress')for(const item of turn.items||[])if(item.type==='agentMessage')this.ingestItem(thread.id,turn.id,item,newThread);
          }catch(e){if(String(e.message).includes('paginated_threads')){this.unsupported.add(thread.id);this.onSession({runtime:'codex',nativeId:thread.id,status:'incompatible'});}else console.warn('[Codex] Read thread failed:',e.message);}
        }
        this.lastSeen.add(thread.id);total++;
      }
      cursor=result.nextCursor||null;
    }while(cursor&&total<300);
  }
  async readRecent(nativeId){
    // Metadata and bounded pages only: never hydrate the full conversation.
    const [metadata,turnPage]=await Promise.all([
      this.rpc.request('thread/read',{threadId:nativeId,includeTurns:false},15000),
      this.rpc.request('thread/turns/list',{threadId:nativeId,limit:3,sortDirection:'desc',itemsView:'summary'},15000)
    ]);
    const turns=(turnPage.data||[]).slice(0,3).reverse();
    let remaining=5;
    for(let i=turns.length-1;i>=0;i--){
      const items=(turns[i].items||[]).filter(item=>item.type==='userMessage'||item.type==='agentMessage');
      turns[i]={...turns[i],items:remaining?items.slice(-remaining):[]};
      remaining-=turns[i].items.length;
    }
    return {...metadata.thread,turns};
  }
  async history(nativeId){
    if(!this.ready)await this.start();
    const result=await this.readRecent(nativeId);
    const turns=result.turns||[];
    const messages=[];
    for(const turn of turns){
      const start=turn.startedAt;
      const parsed=typeof start==='number'?(start>1e11?start:start*1000):Date.parse(start||'');
      const base=Number.isFinite(parsed)?parsed:Date.now();
      let order=0;
      for(const item of turn.items||[]){
        if(item.type!=='agentMessage'&&item.type!=='userMessage')continue;
        const role=item.type==='userMessage'?'user':'agent';
        const body=role==='user'
          ? (item.content||[]).filter(x=>x.type==='text').map(x=>x.text||'').join('\n')
          : item.text;
        if(!body?.trim())continue;
        messages.push({runtime:'codex',nativeId,externalId:'turn:'+turn.id+':'+item.id,
          role,body,createdAt:base+order++,silent:true});
      }
    }
    return messages;
  }
  async send(nativeId,text){
    if(this.unsupported.has(nativeId))throw new Error('This Codex CLI cannot read paginated threads. Upgrade Codex CLI and restart AttnWall.');
    if(!this.ready)await this.start();
    try{
      await this.rpc.request('thread/resume',{threadId:nativeId});
    }catch(error){
      if(!/already has an active writer/i.test(error.message))throw error;
      // Desktop retains its writer even when a conversation is idle. The
      // official durable queue hands the prompt to that owner without resuming
      // a second writer or changing the original conversation.
      const thread=await this.readRecent(nativeId);
      const baseline=new Set((thread.turns||[]).flatMap(t=>(t.items||[]).filter(i=>i.type==='userMessage').map(i=>i.id)));
      const receipt=await this.queuePrompt(nativeId,text);
      const watched=this.queuedThreads.get(nativeId)||{
        pending:[],completed:new Set((thread.turns||[]).filter(t=>['completed','failed','interrupted'].includes(t.status)).map(t=>t.id))
      };
      watched.pending.push({text,baseline,baselineTurns:new Set((thread.turns||[]).map(t=>t.id)),queueId:receipt.queueId});
      this.queuedThreads.set(nativeId,watched);
      this.onSession({runtime:'codex',nativeId,status:'active'});
      return receipt;
    }
    const thread=await this.readRecent(nativeId);
    const input=[{type:'text',text}];
    if(thread?.status?.type==='active'){
      const activeTurn=[...(thread.turns||[])].reverse().find(t=>t.status==='inProgress');
      if(activeTurn?.id)return this.rpc.request('turn/steer',{threadId:nativeId,expectedTurnId:activeTurn.id,input});
      throw new Error('Thread is active; no verified in-progress turn ID for steer');
    }
    return this.rpc.request('turn/start',{threadId:nativeId,input});
  }
  async pollQueued(){
    for(const [nativeId,watched] of this.queuedThreads){
      if(!this.ready)await this.start();
      const thread=await this.readRecent(nativeId);
      const assigned=new Set(watched.pending.map(p=>p.itemId).filter(Boolean));
      for(const turn of thread.turns||[]){
        if(watched.completed.has(turn.id))continue;
        if(!turn.items.some(item=>item.type==='userMessage')&&watched.pending.some(p=>!p.itemId&&!p.baselineTurns.has(turn.id))){
          const first=await this.rpc.request('thread/items/list',{threadId:nativeId,turnId:turn.id,limit:1,sortDirection:'asc'},15000);
          turn.items.unshift(...(first.data||[]).map(entry=>entry.item).filter(item=>item.type==='userMessage'));
        }
        for(const item of turn.items||[]){
          if(item.type!=='userMessage'||assigned.has(item.id))continue;
          const text=extractText(item.content);
          const pending=watched.pending.find(p=>!p.itemId&&!p.baselineTurns.has(turn.id)&&!p.baseline.has(item.id)&&p.text===text);
          if(pending){pending.itemId=item.id;pending.turnId=turn.id;assigned.add(item.id);}
        }
        if(watched.completed.has(turn.id)||!['completed','failed','interrupted'].includes(turn.status))continue;
        // A polled in-progress item can retain its ID as its text streams.
        // Import the terminal snapshot so de-duplication cannot freeze partial text.
        for(const item of turn.items||[])if(item.type==='agentMessage')this.ingestItem(nativeId,turn.id,item);
        this.onComplete({runtime:'codex',nativeId,runId:turn.id,status:turn.status==='completed'?'completed':'failed'});
        watched.completed.add(turn.id);
      }
      watched.pending=watched.pending.filter(p=>!p.turnId||!watched.completed.has(p.turnId));
      if(!watched.pending.length){
        this.queuedThreads.delete(nativeId);this.onSession({runtime:'codex',nativeId,status:'idle'});
      }
    }
  }
  async approve(key,decision){
    if(!['accept','decline','cancel'].includes(decision))throw new Error('Invalid approval decision');
    const frame=this.pendingApprovals.get(String(key));
    if(!frame)throw new Error('Approval no longer pending on this connector');
    this.rpc.respond(frame.id,{decision});
    this.pendingApprovals.delete(String(key));
  }
  close(){this.rpc.close();}
}

export class DshAdapter {
  constructor(onMessage=()=>{},onSession=()=>{},onComplete=()=>{}){
    this.onMessage=onMessage;this.onSession=onSession;this.onComplete=onComplete;
    this.rpc=new RpcProcess(process.env.DSH_BIN||'dsh',['--profile','sdk']);
    this.ready=false;this.known=new Set();this.activeRuns=new Map();
    this.rpc.on('notification',(method,p)=>{
      if(method==='session.event'){
        const event=p.event||{},id=p.sessionId;
        if(!id)return;
        if(event.type==='assistant/message'){
          const text=extractText(event.data?.message?.content?.filter?.(x=>x.type==='text')||event.data?.message?.content);
          if(text){
             if(!this.activeRuns.has(id))this.activeRuns.set(id,'dsh:'+String(event.seq||randomUUID()));
             this.onMessage({runtime:'dsh',nativeId:id,externalId:'event:'+event.seq,body:text,runId:this.activeRuns.get(id)});
           }
        }
        if(event.type==='turn/end'){
          const reason=event.data?.reason;
          const failed=reason?.kind==='error';
          if(failed&&!this.activeRuns.has(id))this.activeRuns.set(id,'dsh:'+String(event.seq||randomUUID()));
          if(failed){
            const code=String(reason.error?.code||'RUNTIME_ERROR').slice(0,40);
            const status=Number.isInteger(reason.error?.status)?` (${reason.error.status})`:'';
            const message=code==='QUOTA'?'模型 API 余额或配额不足':
              code==='UNAUTHORIZED'?'模型 API 认证失败':
              code==='MISSING_CREDENTIAL'?'当前 SDK 路由没有可用的 API Key，请检查凭据来源':
              '请检查 DSH 运行日志及模型提供商配置';
            this.onMessage({runtime:'dsh',nativeId:id,externalId:'failure:'+event.seq,
              body:`DSH 执行失败：${code}${status}。${message}。`,priority:'instant',kind:'diagnostic',runId:this.activeRuns.get(id)||'dsh:'+String(event.seq||randomUUID())});
          }
          this.onSession({runtime:'dsh',nativeId:id,status:failed?'error':'idle'});
           const runId=this.activeRuns.get(id);
           if(runId)this.onComplete({runtime:'dsh',nativeId:id,runId,status:failed?'failed':'completed'});
           this.activeRuns.delete(id);
        }
        if(event.type==='turn/start'){
          this.activeRuns.set(id,'dsh:'+String(event.seq||randomUUID()));
          this.onSession({runtime:'dsh',nativeId:id,status:'active'});
        }
      }
    });
    this.rpc.on('disconnected',()=>{this.ready=false;});
  }
  async start(){
    await this.rpc.start();
    await this.rpc.request('initialize',{cwd:process.env.DSH_CWD||process.cwd(),provider:process.env.DSH_PROVIDER||'deepseek-official',model:process.env.DSH_MODEL||'deepseek-v4-flash'},45000);
    this.ready=true;
  }
  // DSH SDK does not expose session/list; existing session ids can be attached explicitly.
  attach(nativeId){if(this.known.has(nativeId))return;this.known.add(nativeId);this.onSession({runtime:'dsh',nativeId,title:'DSH · '+nativeId.slice(0,8),status:'idle'});}
  create(){const id='attnwall-'+randomUUID();this.attach(id);return id;}
  async send(nativeId,text) {
    if(!this.ready)await this.start();
    this.attach(nativeId);
    return this.rpc.request('session/prompt',{sessionId:nativeId,contentBlocks:[{type:'text',text}]});
  }
  close(){this.rpc.close();}
}
