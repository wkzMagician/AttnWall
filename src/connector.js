import { CodexAdapter, DshAdapter } from './adapters.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
export class Connector {
  constructor({hub,token,host='local'}){
    if(!hub||!token||!/^[a-zA-Z0-9._-]{1,60}$/.test(host))throw new Error('hub, connector token, and valid host required');
    this.hub=hub.replace(/\/$/,'');this.token=token;this.host=host;
    this.sessions=[];this.messages=[];this.completions=[];this.historyComplete=[];this.running=false;
    this.codex=new CodexAdapter(m=>this.onMessage(m),s=>this.onSession(s),c=>this.onComplete(c));
    this.dsh=new DshAdapter(m=>this.onMessage(m),s=>this.onSession(s),c=>this.onComplete(c));
    this.codex.rpc.on('stderr',txt=>{if(process.env.ATTNWALL_VERBOSE==='1')console.error('[codex]',txt.slice(0,500));});
    this.dsh.rpc.on('stderr',txt=>{if(process.env.ATTNWALL_VERBOSE==='1')console.error('[dsh]',txt.slice(0,500));});
  }
  onSession(s){
    if(this.stopped||!s.nativeId||!s.runtime)return;
    const index=this.sessions.findIndex(p=>p.runtime===s.runtime&&p.nativeId===s.nativeId);
    if(index<0)this.sessions.push(s);
    else this.sessions[index]={...this.sessions[index],...s};
  }
  onMessage(m) {
    if(this.stopped||!m.nativeId||!m.body)return;
    if(!this.sessions.some(s=>s.nativeId===m.nativeId&&s.runtime===m.runtime))
      this.sessions.push({nativeId:m.nativeId,runtime:m.runtime,title:m.title||m.nativeId});
    this.messages.push({...m,createdAt:m.createdAt||Date.now()});
  }
  onComplete(c){if(!this.stopped&&c.nativeId&&c.runId)this.completions.push(c);}
  async api(method,path,data) {
    const r=await fetch(this.hub+path,{method,headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(20000)});
    let value;try{value=await r.json();}catch{throw new Error('Bad hub response '+r.status);}
    if(!r.ok)throw new Error(value.error||'Hub '+r.status);
    return value;
  }
  async flush() {
    if(this.flushing)return this.flushing;
    if(!this.sessions.length&&!this.messages.length&&!this.completions.length&&!this.historyComplete.length)return;
    this.flushing=(async()=>{
      const sessions=this.sessions.slice(0,20),messages=this.messages.slice(0,5);
      const historyComplete=messages.length===this.messages.length?this.historyComplete.slice(0,10):[];
      const completions=messages.length===this.messages.length?this.completions.slice(0,10):[];
      await this.api('POST','/api/connector/sync',{host:this.host,sessions,messages,completions,historyComplete});
      for(const session of sessions){const index=this.sessions.indexOf(session);if(index>=0)this.sessions.splice(index,1);}
      this.messages.splice(0,messages.length);
      this.historyComplete.splice(0,historyComplete.length);
      this.completions.splice(0,completions.length);
    })();
    try{await this.flushing;}finally{this.flushing=null;}
  }
  async tick() {
    if(this.busy||this.stopped)return;
    this.busy=true;
    try{
      const {jobs,dsh,historyRequests}=await this.api('GET','/api/connector/jobs?host='+encodeURIComponent(this.host)+(this.historyTask?'&history=0':''));
      if(this.stopped)return;
      for(const id of dsh||[])this.dsh.attach(id);
      // Delivery has priority over metadata discovery and historical backfills.
      for(const job of jobs||[]){
        try{
          const adapter=job.runtime==='codex'?this.codex:this.dsh;
          if(job.kind==='approval')await this.codex.approve(job.approval_key,job.text);
          else await adapter.send(job.native_id,job.text);
          await this.api('POST','/api/connector/ack',{id:job.id,state:'sent'});
        }catch(e){
          console.error('[AttnWall] Reply delivery failed:',e.message);
          await this.api('POST','/api/connector/ack',{id:job.id,state:'failed',error:e.message});
        }
      }
      await this.flush();
      if(!this.historyTask&&historyRequests?.length){
        this.historyTask=(async()=>{
          for(const request of historyRequests){
            if(this.stopped)return;
            try{
              const items=await this.codex.history(request.native_id);
              if(this.stopped)return;
              for(const item of items)this.onMessage(item);
              this.historyComplete.push({sessionId:request.session_id});
            }catch(e){
              if(this.stopped)return;
              this.historyComplete.push({sessionId:request.session_id,error:e.message||'Unable to fetch history'});
            }
            while(!this.stopped&&(this.messages.length||this.sessions.length||this.historyComplete.length))await this.flush();
          }
        })().catch(e=>console.error('[AttnWall] History sync:',e.message)).finally(()=>{this.historyTask=null;});
      }
      if(!this.queuedPoll){
        this.queuedPoll=this.codex.pollQueued().then(()=>this.stopped?undefined:this.flush())
          .catch(e=>console.error('[AttnWall] Queued response:',e.message)).finally(()=>{this.queuedPoll=null;});
      }
      if(!this.metadataTask&&(!this.lastSync||Date.now()-this.lastSync>30000)){
        this.lastSync=Date.now();
        this.metadataTask=this.codex.sync().then(async()=>{
          while(!this.stopped&&(this.sessions.length||this.messages.length||this.completions.length||this.historyComplete.length))await this.flush();
        }).catch(e=>{
          if(Date.now()-(this.lastCodexError||0)>60000){console.error('[AttnWall] Codex:',e.message);this.lastCodexError=Date.now();}
        }).finally(()=>{this.metadataTask=null;});
      }
    }catch(e){if(Date.now()-(this.lastError||0)>10000){console.error('[AttnWall] Connector:',e.message);this.lastError=Date.now();}}
    finally{this.busy=false;}
  }
  start(){
    if(this.running)return;
    this.running=true;this.stopped=false;console.log('[AttnWall] Connector '+this.host+' -> '+this.hub);
    this.timer=setInterval(()=>void this.tick(),2500);
    void this.tick();
  }
  stop(){clearInterval(this.timer);this.running=false;this.stopped=true;this.codex.close();this.dsh.close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2);
  const pick=(name)=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1];};
  const hub=pick('hub')||process.env.ATTNWALL_HUB||'http://127.0.0.1:3360';
  const host=pick('host')||process.env.ATTNWALL_CONNECTOR_HOST||'local';
  const localSecrets=existsSync('.data/secrets.json')?JSON.parse(readFileSync('.data/secrets.json','utf8')):{};
  const token=pick('token')||process.env.ATTNWALL_CONNECTOR_TOKEN||localSecrets.connectorToken;
  if(!token){console.error('Set ATTNWALL_CONNECTOR_TOKEN');process.exit(1);}
  const connector=new Connector({hub,host,token});connector.start();
  process.on('SIGINT',()=>{connector.stop();process.exit(0);});
}
