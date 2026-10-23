import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, loadSecrets, secretEqual } from './core.js';
import { NotificationScheduler } from './notify.js';import { handleBrowserBridge } from './browser-bridge.js';

const root=resolve(fileURLToPath(new URL('../public/',import.meta.url)));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png'};
const port=Number(process.env.ATTNWALL_PORT||3360);
const listen=process.env.ATTNWALL_HOST||'127.0.0.1';
const store=new Store(),secrets=loadSecrets(),listeners=new Set();
const notify=new NotificationScheduler(store,{broadcast});
const loginAttempts=new Map();
function broadcast(type,data) {
  const event='event: '+type+'\ndata: '+JSON.stringify(data)+'\n\n';
  for(const res of listeners)try{res.write(event);}catch{listeners.delete(res);}
}
function reply(res,status,obj,headers={}) {
  const data=JSON.stringify(obj);
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});
  res.end(data);
}
function fail(res,status,message){reply(res,status,{error:message});}
async function body(req,maxBytes=1048576) {
  let length=0;const chunks=[];
  for await(const part of req){length+=part.length;if(length>maxBytes)throw new Error('Request too large');chunks.push(part);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
}
function tokenFrom(req){
  const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('aw_session='));
  return cookie?decodeURIComponent(cookie.slice('aw_session='.length)):null;
}
function isAuthenticated(req,connector=false){
  const bearer=(req.headers.authorization||'').replace(/^Bearer /i,'');
  const target=connector?secrets.connectorToken:secrets.accessToken;
  return secretEqual(bearer,target)||(!connector&&secretEqual(tokenFrom(req),target));
}
function sameOrigin(req){
  const origin=req.headers.origin;if(!origin)return true;
  try{return new URL(origin).host===req.headers.host;}catch{return false;}
}
const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://localhost');
    const isApi=u.pathname.startsWith('/api/');
    if(u.pathname.startsWith('/api/browser/')&&u.pathname!=='/api/browser/setup'){
      await handleBrowserBridge(req,res,u,{store,secrets,notify,broadcast});return;
    }
    if(req.method!=='GET'&&req.method!=='HEAD'&&!sameOrigin(req))return fail(res,403,'Cross-origin requests rejected');
    if(u.pathname==='/api/login'&&req.method==='POST'){
      const addr=req.socket.remoteAddress;
      const current=loginAttempts.get(addr)||{count:0,until:0};
      if(current.until>Date.now())return fail(res,429,'Too many login attempts');
      const data=await body(req);
      if(!secretEqual(data.token,secrets.accessToken)){
        current.count++;current.until=current.count>=8?Date.now()+60000:0;loginAttempts.set(addr,current);
        return fail(res,401,'Incorrect access key');
      }
      loginAttempts.delete(addr);
      const secure=req.socket.encrypted||req.headers['x-forwarded-proto']==='https';
      const cookie='aw_session='+encodeURIComponent(secrets.accessToken)+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000'+(secure?'; Secure':'');
      return reply(res,200,{ok:true},{'Set-Cookie':cookie});
    }
    if(u.pathname==='/api/health')return reply(res,200,{ok:true});
    const connector=u.pathname.startsWith('/api/connector/');
    if(isApi&&!isAuthenticated(req,connector))return fail(res,401,'Authentication required');
    if(u.pathname==='/api/logout'&&req.method==='POST')return reply(res,200,{ok:true},{'Set-Cookie':'aw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
    if(u.pathname==='/api/browser/setup'&&req.method==='GET')
      return reply(res,200,{browserToken:secrets.browserToken,version:1});
    if(u.pathname==='/api/state'&&req.method==='GET')return reply(res,200,{
      sessions:store.readySessions(),inbox:store.readyInbox(100),unreadCount:store.readyUnreadCount(),settings:store.settings(),nextBatchAt:notify.nextAt,
      queuedNormal:store.pendingNotifications().length,pushPublicKey:notify.publicKey(),
      pushDevices:notify.devices(),pushReport:notify.lastReport()
    });
    if(u.pathname==='/api/messages'&&req.method==='GET'){
      const sid=u.searchParams.get('sessionId');
      if(!store.sessionById(sid))return fail(res,404,'Session not found');
      const beforeTime=u.searchParams.has('beforeTime')?Number(u.searchParams.get('beforeTime')):null;
      const beforeId=u.searchParams.get('beforeId');
      const page=store.messagePage(sid,{limit:Number(u.searchParams.get('limit')||5),beforeTime,beforeId});
      return reply(res,200,{...page,replies:u.searchParams.has('beforeTime')?[]:store.replies(sid).slice(0,5),history:store.historyStatus(sid)});
    }
    if(u.pathname==='/api/messages/read'&&req.method==='POST'){
      const p=await body(req);
      if(!Array.isArray(p.ids)||p.ids.length>500||p.ids.some(x=>typeof x!=='string'))return fail(res,400,'Invalid ids');
      store.readMessages(p.ids);broadcast('update',{kind:'read'});return reply(res,200,{ok:true});
    }
    if(u.pathname==='/api/messages/read-all'&&req.method==='POST'){
      const p=await body(req);
      if(p.sessionId && !store.sessionById(p.sessionId))return fail(res,404,'Unknown session');
      const updated=store.markAllRead(p.sessionId||null);
      broadcast('update',{kind:'read',count:updated});return reply(res,200,{ok:true,updated});
    }
    if(u.pathname==='/api/sessions/history'&&req.method==='POST'){
      const p=await body(req);if(!store.sessionById(p.sessionId))return fail(res,404,'Unknown session');
      const session=store.sessionById(p.sessionId);
      if(!['codex','chatgpt-web','codex-web','deepseek-web'].includes(session.runtime))return reply(res,200,{history:null,note:'Runtime does not support historical synchronization'});
      const history=store.requestHistory(p.sessionId,{force:!!p.force});
      return reply(res,200,{history});
    }
    if(u.pathname==='/api/settings'&&req.method==='POST'){
      const p=await body(req),settings=store.updateSettings(p);
      notify.reset();broadcast('update',{kind:'settings'});return reply(res,200,{settings});
    }
    if(u.pathname==='/api/replies/image'&&req.method==='POST'){
      const p=await body(req,4_500_000);
      const queued=store.queueImageReply(p.sessionId,p.text||'',p.image,p.id||randomUUID());
      broadcast('update',{kind:'reply',sessionId:p.sessionId});
      return reply(res,200,{reply:queued});
    }
    if(u.pathname==='/api/replies'&&req.method==='POST'){
      const p=await body(req), r=store.queueReply(p.sessionId,p.text,p.id||randomUUID());
      broadcast('update',{kind:'reply',sessionId:p.sessionId});return reply(res,200,{reply:r});
    }
    if(u.pathname==='/api/approvals'&&req.method==='POST'){
      const p=await body(req),r=store.queueApproval(p.messageId,p.decision);
      broadcast('update',{kind:'approval',sessionId:r.session_id});return reply(res,200,{reply:r});
    }
    if(u.pathname==='/api/replies/retry'&&req.method==='POST'){
      const p=await body(req),r=store.db.prepare('SELECT * FROM replies WHERE id=?').get(p.id);
      if(!r||r.state!=='failed')return fail(res,409,'Only failed replies can be retried');
      store.replyState(p.id,'queued');broadcast('update',{kind:'retry'});return reply(res,200,{ok:true});
    }
    if(u.pathname==='/api/sessions/instant'&&req.method==='POST'){
      const p=await body(req);
      if(typeof p.enabled!=='boolean')return fail(res,400,'Invalid Instant state');
      const session=store.instantMode(p.sessionId,p.enabled);
      broadcast('update',{kind:'instantMode',sessionId:p.sessionId});return reply(res,200,{session});
    }
    if(u.pathname==='/api/sessions/attach'&&req.method==='POST'){
      const p=await body(req);
      if((p.runtime&&p.runtime!=='dsh')||typeof p.nativeId!=='string'||!p.nativeId.trim()||p.nativeId.length>250)return fail(res,400,'DSH session ID required');
      const host=typeof p.host==='string'&&/^[a-zA-Z0-9._-]{1,60}$/.test(p.host)?p.host:'local';
      const id=store.session({runtime:'dsh',host,nativeId:p.nativeId,title:p.title||'DSH · '+p.nativeId});
      broadcast('update',{kind:'session'});return reply(res,200,{id});
    }
    if(u.pathname==='/api/sessions/new-dsh'&&req.method==='POST'){
      const p=await body(req),host=typeof p.host==='string'&&/^[a-zA-Z0-9._-]{1,60}$/.test(p.host)?p.host:'local';
      const id=store.session({runtime:'dsh',host,nativeId:'attnwall-'+randomUUID(),title:p.title||'New DSH session'});
      broadcast('update',{kind:'session'});return reply(res,200,{id});
    }
    if(u.pathname==='/api/push'&&req.method==='POST'){
      const p=await body(req);store.saveSubscription(p.subscription,p.name);return reply(res,200,{ok:true});
    }
    if(u.pathname==='/api/push/test'&&req.method==='POST'){
      const p=await body(req);
      const report=await notify.testDevice(p.deviceId);
      return reply(res,200,{report});
    }
    if(u.pathname==='/api/events'&&req.method==='GET'){
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
      res.write(': connected\n\n');listeners.add(res);
      const timer=setInterval(()=>res.write(': heartbeat\n\n'),25000);
      req.on('close',()=>{clearInterval(timer);listeners.delete(res);});return;
    }
    if(u.pathname==='/api/connector/sync'&&req.method==='POST'){
      const p=await body(req),host=p.host;
      if(typeof host!=='string'||!/^[a-zA-Z0-9._-]{1,60}$/.test(host))return fail(res,400,'Invalid host');
      let added=0;
      for(const s of (Array.isArray(p.sessions)?p.sessions:[]).slice(0,200)){
        if(!s.nativeId||!['codex','dsh'].includes(s.runtime))continue;
        store.session({host,...s});
      }
      for(const m of (Array.isArray(p.messages)?p.messages:[]).slice(0,200)){
        if(!m.nativeId||!['codex','dsh'].includes(m.runtime))continue;
        const previous=store.sessionById(host+':'+m.runtime+':'+m.nativeId);
        const sessionId=store.session({host,runtime:m.runtime,nativeId:m.nativeId,title:m.title||previous?.title||m.nativeId,status:previous?.status||'idle'});
        const message=store.message({sessionId,externalId:m.externalId,role:m.role==='user'?'user':'agent',body:m.body,
          priority:store.setting('instantEnabled')&&(m.priority==='instant'||!!store.sessionById(sessionId).instant_mode)?'instant':'normal',kind:m.kind||'message',runId:m.runId||'',createdAt:m.createdAt||Date.now(),silent:!!m.silent});
        if(message){
          added++;
          if(message.role==='agent'&&['approval','userInput'].includes(message.kind)&&!m.silent)
             void notify.instant({...message,title:store.sessionById(sessionId).title}).catch(console.error);
        }
      }
      for(const completion of (Array.isArray(p.completions)?p.completions:[]).slice(0,40)){
        if(!['codex','dsh'].includes(completion.runtime)||typeof completion.runId!=='string')continue;
        const sessionId=host+':'+completion.runtime+':'+completion.nativeId;
        if(!store.sessionById(sessionId))continue;
        const final=store.completeRun(sessionId,completion.runId,{status:completion.status||'completed'});
        if(final?.priority==='instant')void notify.instant({...final,title:store.sessionById(sessionId).title}).catch(console.error);
      }
      for(const h of (Array.isArray(p.historyComplete)?p.historyComplete:[]).slice(0,20)){
        const session=store.sessionById(h.sessionId);
        if(!session||session.host!==host||session.runtime!=='codex')continue;
        store.completeHistory(h.sessionId,typeof h.error==='string'?h.error.slice(0,500):null);
      }
      if(added||p.sessions?.length||p.historyComplete?.length||p.completions?.length)broadcast('update',{kind:'sync',added});
      return reply(res,200,{ok:true,added});
    }
    if(u.pathname==='/api/connector/jobs'&&req.method==='GET'){
      const host=u.searchParams.get('host');
      if(!host||!/^[a-zA-Z0-9._-]{1,60}$/.test(host))return fail(res,400,'Invalid host');
      const jobs=store.claimReplies(host);
      const historyRequests=u.searchParams.get('history')==='0'?[]:store.claimHistory(host);
      const dsh=store.sessions().filter(s=>s.host===host&&s.runtime==='dsh').map(x=>x.native_id);
      return reply(res,200,{jobs,dsh,historyRequests});
    }
    if(u.pathname==='/api/connector/ack'&&req.method==='POST'){
      const p=await body(req);
      if(!p.id||!['sent','failed'].includes(p.state))return fail(res,400,'Invalid acknowledgment');
      store.replyState(p.id,p.state,p.error||null);broadcast('update',{kind:'replyState'});return reply(res,200,{ok:true});
    }
    if(isApi)return fail(res,404,'Unknown API');
    if(req.method!=='GET'&&req.method!=='HEAD')return fail(res,405,'Method not allowed');
    const requested=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname).replace(/^\/+/,'');
    const file=resolve(root,requested);
    if(file!==root&&!file.startsWith(root+'\\')&&!file.startsWith(root+'/'))return fail(res,403,'Forbidden');
    if(!existsSync(file))return fail(res,404,'Not found');
    const data=readFileSync(file);
    res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Content-Length':data.length,'Cache-Control':['.html','.js','.css','.webmanifest'].includes(extname(file))?'no-cache, must-revalidate':'public, max-age=300','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'"});
    res.end(req.method==='HEAD'?undefined:data);
  }catch(e){console.error('Request error:',e);if(!res.headersSent)fail(res,400,e.message);else res.end();}
});
server.listen(port,listen,()=>{
  console.log('AttnWall: http://'+listen+':'+port);
  console.log('Access key (private): '+secrets.accessToken);
  console.log('Connector key (private): '+secrets.connectorToken);
  console.log('Use HTTPS/Tailscale for remote or mobile access.');
  notify.start();
  if(process.env.ATTNWALL_LOCAL_CONNECTOR!=='0'){
    import('./connector.js').then(({Connector})=>new Connector({hub:'http://127.0.0.1:'+port,token:secrets.connectorToken,host:'local'}).start()).catch(console.error);
  }
});
process.on('SIGINT',()=>{notify.stop();server.close();store.close();process.exit(0);});
