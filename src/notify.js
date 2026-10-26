import webpush from 'web-push';import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import { inDnd } from './core.js';
import {pushTransport,pushOptions,pushFailure} from './push-transport.js';
const deviceId=endpoint=>createHash('sha256').update(endpoint).digest('hex').slice(0,20);
export class NotificationScheduler {
  constructor(store,{broadcast=()=>{},vapidFile='.data/vapid.json',transport=pushTransport()}={}) {
    this.store=store;this.broadcast=broadcast;this.timer=null;
    this.transport=transport;
    if(!existsSync(vapidFile))writeFileSync(vapidFile,JSON.stringify(webpush.generateVAPIDKeys()),{mode:0o600,flag:'wx'});
    this.keys=JSON.parse(readFileSync(vapidFile,'utf8'));
    webpush.setVapidDetails(process.env.ATTNWALL_VAPID_SUBJECT||'https://example.com',this.keys.publicKey,this.keys.privateKey);
    // The first outstanding run starts the clock; only terminal outputs can be released.
  }
  publicKey(){return this.keys.publicKey;}
  devices(){return this.store.subscriptions().map(row=>({id:deviceId(row.endpoint),name:row.device_name,
    provider:new URL(row.endpoint).hostname.includes('apple.com')?'Apple Push':'Browser Push',registeredAt:row.created_at}));}
  lastReport(){try{const value=this.store.setting('__pushReport');return typeof value==='string'?JSON.parse(value):value;}catch{return null;}}
  saveReport(report){this.store.db.prepare("INSERT INTO settings(key,value) VALUES ('__pushReport',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(report));}
  testDevice(id){
    if(typeof id!=='string'||!this.devices().some(d=>d.id===id))throw new Error('Unknown push subscription');
    const english=this.store.setting('locale')==='en';
    return this.send({
      kind:'test',
      title:english?'AttnWall push notification test':'AttnWall 系统通知测试',
      body:english?'If you can see this, Web Push is working on this device.':'如果看到了这条通知，说明设备的 Web Push 通道已正常工作。'
    },{deviceId:id,broadcast:false});
  }
  start(){this.timer=setInterval(()=>this.tick().catch(console.error),5000);this.timer.unref?.();}
  stop(){if(this.timer)clearInterval(this.timer);}
  get nextAt(){
    const firstStart=this.store.pendingBatchAnchor();
    if(firstStart===null)return null;
    const anchor=Math.max(firstStart,this.store.lastBatchAt());
    return Math.max(anchor+this.store.setting('intervalMin')*60000,this.store.pendingCompletionAt()||0);
  }
  reset(){/* deadline follows task starts, the last actual batch release and completions */}
  async tick(now=Date.now()){
    if(this.ticking)return;
    this.ticking=true;
    try{
      const due=this.nextAt;
      if(due!==null&&now>=due&&!inDnd(now,this.store.settings())){
        this.store.db.exec('BEGIN IMMEDIATE');
        try{
          const batch=this.store.claimNotificationBatch(now,due);
          if(batch.length){
            this.store.noteBatch(now);
            const english=this.store.setting('locale')==='en';
            this.store.enqueueNotification({kind:'batch',title:english?'AttnWall · '+batch.length+' new messages':'AttnWall · '+batch.length+' 条新消息',body:batch.slice(0,3).map(m=>m.title+': '+m.body.slice(0,40)).join(' | '),count:batch.length,messageIds:batch.map(message=>message.id)},{at:now});
          }
          this.store.db.exec('COMMIT');
        }catch(error){this.store.db.exec('ROLLBACK');throw error;}
      }
      await this.drain(now);
    }finally{this.ticking=false;}
  }
  async instant(message){
    if(!this.store.setting('instantEnabled')&&!['approval','userInput'].includes(message.kind))return;
    this.store.db.exec('BEGIN IMMEDIATE');
    try{
      this.store.markInstantNotified(message.id);
      const english=this.store.setting('locale')==='en';
      this.store.enqueueNotification({kind:'instant',title:(english?'Instant · ':'即时 · ')+message.title,body:message.body.slice(0,180),sessionId:message.session_id,messageIds:[message.id]},{id:'instant:'+message.id});
      this.store.db.exec('COMMIT');
    }catch(error){this.store.db.exec('ROLLBACK');throw error;}
    await this.drain();
  }
  async send(payload,{deviceId:targetId=null,broadcast=true}={}){
    this.store.db.exec('BEGIN IMMEDIATE');
    let notice;
    try{
      notice=this.store.enqueueNotification(payload,{id:payload.notificationId,broadcast,targetId:targetId?endpoint=>deviceId(endpoint)===targetId:null});
      this.store.db.exec('COMMIT');
    }catch(error){this.store.db.exec('ROLLBACK');throw error;}
    await this.drain();
    const report=this.report(notice.notificationId);
    this.saveReport(report);return report;
  }
  report(id,now=Date.now()){
    const report=this.store.notificationReport(id,now);
    report.results=report.results.map(({endpoint,...result})=>({id:deviceId(endpoint),...result}));
    return report;
  }
  notice(payload){const {messageIds,...notice}=payload;return ['batch','instant'].includes(payload.kind)?{...notice,unreadCount:this.store.readyUnreadCount()}:notice;}
  hasUnread(payload){return !payload.messageIds?.length||payload.messageIds.some(id=>this.store.db.prepare('SELECT 1 FROM messages WHERE id=? AND read_at IS NULL').get(id));}
  async drain(now=Date.now()){
    if(this.draining)return this.draining;
    this.draining=this.dispatch(now);
    try{await this.draining;}finally{this.draining=null;}
  }
  async dispatch(now){
    for(const row of this.store.pendingBroadcasts(now)){
      const payload=JSON.parse(row.payload);
      if(payload.kind==='batch'&&inDnd(now,this.store.settings()))continue;
      const claimed=this.store.db.prepare('UPDATE notification_events SET broadcast_at=? WHERE id=? AND broadcast_at IS NULL').run(now,row.id);
      if(claimed.changes&&this.hasUnread(payload))this.broadcast('notification',this.notice(payload));
    }
    const jobs=this.store.claimPushDeliveries(now,!inDnd(now,this.store.settings()));
    await Promise.all(jobs.map(async job=>{
      const payload=JSON.parse(job.payload),notice=this.notice(payload);
      const status={accepted:false,code:null,reason:null};
      if(!this.hasUnread(payload)){
        this.store.db.prepare("UPDATE push_deliveries SET state='cancelled',lease_until=NULL,reason='消息已读，已取消补发' WHERE event_id=? AND endpoint=?").run(job.event_id,job.endpoint);
        return;
      }
      try{
        const r=await webpush.sendNotification(JSON.parse(job.subscription),JSON.stringify(notice),
          {...pushOptions(job.endpoint,this.transport),TTL:Math.max(1,Math.ceil((job.expires_at-now)/1000)),urgency:['instant','test'].includes(payload.kind)?'high':'normal'});
        status.code=r.statusCode;status.accepted=r.statusCode>=200&&r.statusCode<300;
      }catch(e){
        Object.assign(status,pushFailure(e));
        const retryAfter=e.headers?.['retry-after'];
        if(retryAfter){
          const delay=Number.isFinite(Number(retryAfter))?Number(retryAfter)*1000:Date.parse(retryAfter)-now;
          if(Number.isFinite(delay)&&delay>0)status.retryAfter=Math.min(delay,86400000);
        }
        if([404,410].includes(e.statusCode))this.store.removeSubscription(job.endpoint);
        console.error('Push failed:',job.device_name,new URL(job.endpoint).hostname,status.code?'HTTP '+status.code:'network',status.reason);
      }
      this.store.finishPush(job,status,now);
    }));
    for(const id of new Set(jobs.map(job=>job.event_id)))this.saveReport(this.report(id,now));
    const last=this.lastReport();
    if(last?.notificationId&&this.store.db.prepare('SELECT 1 FROM notification_events WHERE id=?').get(last.notificationId)){
      const updated=this.report(last.notificationId,now);
      if(JSON.stringify(last.results)!==JSON.stringify(updated.results))this.saveReport(updated);
    }
  }
}
