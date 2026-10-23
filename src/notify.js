import webpush from 'web-push';import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import { inDnd } from './core.js';
const deviceId=endpoint=>createHash('sha256').update(endpoint).digest('hex').slice(0,20);
export class NotificationScheduler {
  constructor(store,{broadcast=()=>{},vapidFile='.data/vapid.json'}={}) {
    this.store=store;this.broadcast=broadcast;this.timer=null;
    if(!existsSync(vapidFile))writeFileSync(vapidFile,JSON.stringify(webpush.generateVAPIDKeys()),{mode:0o600,flag:'wx'});
    this.keys=JSON.parse(readFileSync(vapidFile,'utf8'));
    webpush.setVapidDetails(process.env.ATTNWALL_VAPID_SUBJECT||'https://example.com',this.keys.publicKey,this.keys.privateKey);
    // No countdown during idle. The first outstanding message starts a persisted batch window.
  }
  publicKey(){return this.keys.publicKey;}
  devices(){return this.store.subscriptions().map(row=>({id:deviceId(row.endpoint),name:row.device_name,
    provider:new URL(row.endpoint).hostname.includes('apple.com')?'Apple Push':'Browser Push',registeredAt:row.created_at}));}
  lastReport(){try{return JSON.parse(this.store.setting('__pushReport')||'null');}catch{return null;}}
  saveReport(report){this.store.db.prepare("INSERT INTO settings(key,value) VALUES ('__pushReport',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(report));}
  testDevice(id){
    if(typeof id!=='string'||!this.devices().some(d=>d.id===id))throw new Error('Unknown push subscription');
    return this.send({kind:'test',title:'AttnWall 系统通知测试',body:'如果看到了这条通知，说明设备的 Web Push 通道已正常工作。'},{deviceId:id,broadcast:false});
  }
  start(){this.timer=setInterval(()=>this.tick().catch(console.error),5000);this.timer.unref?.();}
  stop(){if(this.timer)clearInterval(this.timer);}
  get nextAt(){const anchor=this.store.pendingBatchAnchor();return anchor===null?null:anchor+this.store.setting('intervalMin')*60000;}
  reset(){/* deadline is derived from persisted first pending arrival and settings */}
  async tick(now=Date.now()){
    const due=this.nextAt;
    if(due===null||now<due||inDnd(now,this.store.settings()))return;
    const batch=this.store.claimNotificationBatch(now);
    // New messages after release create a new window; never align to wall clock.
    if(batch.length){this.store.noteBatch(now);await this.send({kind:'batch',title:'AttnWall · '+batch.length+' 条新消息',body:batch.slice(0,3).map(m=>m.title+': '+m.body.slice(0,40)).join(' | '),count:batch.length});}
  }
  async instant(message){
    if(!this.store.setting('instantEnabled'))return;
    this.store.markInstantNotified(message.id);
    await this.send({kind:'instant',title:'Instant · '+message.title,body:message.body.slice(0,180),sessionId:message.session_id});
  }
  async send(payload,{deviceId:targetId=null,broadcast=true}={}){
    // Include the server-authoritative released unread total for background PWA badges.
    // Test pushes must not replace an existing badge with an unrelated count.
    const notice=['batch','instant'].includes(payload.kind)
      ? {...payload,unreadCount:this.store.readyUnreadCount()}:payload;
    if(broadcast)this.broadcast('notification',notice);
    const rows=this.store.subscriptions().filter(row=>!targetId||deviceId(row.endpoint)===targetId);
    const results=await Promise.all(rows.map(async row=>{
      const status={id:deviceId(row.endpoint),name:row.device_name,accepted:false,code:null,reason:null};
      try{
        const r=await webpush.sendNotification(JSON.parse(row.subscription),JSON.stringify(notice),
          {TTL:payload.kind==='test'?120:3600,urgency:['instant','test'].includes(payload.kind)?'high':'normal'});
        status.code=r.statusCode;status.accepted=r.statusCode>=200&&r.statusCode<300;
      }catch(e){
        status.code=e.statusCode||null;
        try{status.reason=JSON.parse(e.body||'{}').reason||null;}catch{}
        status.reason ||= e.message?.slice(0,100)||'Unknown error';
        if([404,410].includes(e.statusCode))this.store.removeSubscription(row.endpoint);
        console.error('Push failed:',row.device_name,status.code,status.reason);
      }
      return status;
    }));
    const report={kind:payload.kind,at:Date.now(),results};this.saveReport(report);
    return report;
  }
}
