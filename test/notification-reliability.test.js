import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import webpush from 'web-push';
import {Store} from '../src/core.js';
import {NotificationScheduler} from '../src/notify.js';

async function fixture(run){
  const dir=mkdtempSync(join(tmpdir(),'aw-notify-reliable-')),original=webpush.sendNotification;
  const ctx={dir,store:new Store(join(dir,'store.db')),calls:[],broadcasts:[]};
  ctx.store.updateSettings({dndEnabled:false,intervalMin:1});
  ctx.subscribe=host=>ctx.store.saveSubscription({endpoint:'https://'+host+'/private-token',keys:{p256dh:'test',auth:'test'}},host);
  ctx.scheduler=()=>new NotificationScheduler(ctx.store,{vapidFile:join(dir,'vapid.json'),transport:{timeout:15000},broadcast:(type,data)=>ctx.broadcasts.push({type,data})});
  ctx.restart=()=>{ctx.store.close();ctx.store=new Store(join(dir,'store.db'));return ctx.scheduler();};
  webpush.sendNotification=async(subscription,payload)=>{ctx.calls.push({host:new URL(subscription.endpoint).hostname,payload:JSON.parse(payload)});return {statusCode:201};};
  try{await run(ctx);}finally{webpush.sendNotification=original;ctx.store.close();rmSync(dir,{recursive:true,force:true});}
}

test('Only the failed device retries, with backoff, even when the message batch is empty',()=>fixture(async ctx=>{
  ctx.subscribe('fcm.googleapis.com');ctx.subscribe('web.push.apple.com');
  const accepted=webpush.sendNotification;let fail=true;
  webpush.sendNotification=async(...args)=>{
    const result=await accepted(...args);
    if(args[0].endpoint.includes('fcm.')&&fail){fail=false;throw Object.assign(new Error('timeout'),{code:'ETIMEDOUT'});}
    return result;
  };
  const sender=ctx.scheduler(),report=await sender.send({kind:'batch',title:'Completed',body:'Done'});
  assert.equal(report.results.filter(r=>r.accepted).length,1);
  const retryAt=report.results.find(r=>!r.accepted).retryAt;
  assert.ok(retryAt>Date.now());
  await sender.tick(retryAt-1);assert.equal(ctx.calls.length,2);
  await sender.tick(retryAt);assert.equal(ctx.calls.length,3);
  assert.equal(ctx.calls.filter(c=>c.host==='web.push.apple.com').length,1);
  assert.ok(sender.lastReport().results.every(r=>r.accepted));
  assert.equal(ctx.broadcasts.length,1,'Device retries do not repeat the foreground alert');
  assert.equal(ctx.calls[0].payload.notificationId,ctx.calls[2].payload.notificationId);
  assert.doesNotMatch(JSON.stringify(sender.lastReport()),/private-token|endpoint/);
}));

test('Instant completion survives restart before the server dispatch callback runs',()=>fixture(async ctx=>{
  ctx.subscribe('fcm.googleapis.com');
  const sid=ctx.store.session({runtime:'codex',nativeId:'restart'});
  ctx.store.message({sessionId:sid,body:'Completed',priority:'instant',runId:'run'});
  ctx.store.completeRun(sid,'run');
  const sender=ctx.restart();await sender.tick();await sender.tick();
  assert.equal(ctx.calls.length,1);assert.equal(ctx.broadcasts.length,1);
  assert.equal(ctx.store.readyUnreadCount(),1);
}));

test('A failed delivery survives restart without replaying the accepted device',()=>fixture(async ctx=>{
  ctx.subscribe('fcm.googleapis.com');ctx.subscribe('web.push.apple.com');
  const accepted=webpush.sendNotification;
  webpush.sendNotification=async(...args)=>{
    if(args[0].endpoint.includes('fcm.'))throw Object.assign(new Error('offline'),{code:'ECONNREFUSED'});
    return accepted(...args);
  };
  const report=await ctx.scheduler().send({kind:'instant',title:'Completed',body:'Done'});
  const retryAt=report.results.find(r=>!r.accepted).retryAt;
  webpush.sendNotification=accepted;
  await ctx.restart().tick(retryAt);
  assert.equal(ctx.calls.filter(c=>c.host==='web.push.apple.com').length,1);
  assert.equal(ctx.calls.filter(c=>c.host==='fcm.googleapis.com').length,1);
  assert.equal(ctx.broadcasts.length,1);
}));

test('Batch release and its durable event roll back together',()=>fixture(async ctx=>{
  ctx.subscribe('fcm.googleapis.com');
  const sid=ctx.store.session({runtime:'codex',nativeId:'atomic'}),now=Date.now();
  ctx.store.message({sessionId:sid,body:'Done',runId:'run'});
  ctx.store.completeRun(sid,'run',{at:now-61000});
  const enqueue=ctx.store.enqueueNotification;
  ctx.store.enqueueNotification=()=>{throw new Error('Storage failed');};
  const sender=ctx.scheduler();await assert.rejects(sender.tick(now),/Storage failed/);
  assert.equal(ctx.store.readyUnreadCount(),0);assert.equal(ctx.store.pendingNotifications().length,1);
  ctx.store.enqueueNotification=enqueue;await sender.tick(now);
  assert.equal(ctx.calls.length,1);assert.equal(ctx.store.readyUnreadCount(),1);
}));

test('Concurrent scheduler ticks cannot send the same delivery twice',()=>fixture(async ctx=>{
  ctx.subscribe('fcm.googleapis.com');const now=Date.now();
  ctx.store.enqueueNotification({kind:'instant',title:'Done',body:'Done'},{at:now});
  let release;const accepted=webpush.sendNotification;
  webpush.sendNotification=async(...args)=>{await accepted(...args);await new Promise(resolve=>release=resolve);return {statusCode:201};};
  const sender=ctx.scheduler(),first=sender.tick(now),second=sender.tick(now);
  await Promise.resolve();assert.equal(ctx.calls.length,1);release();await Promise.all([first,second]);
  await sender.tick(now+1000);assert.equal(ctx.calls.length,1);
}));

test('Expired worker leases recover after restart, without stealing active leases',()=>fixture(async ctx=>{
  ctx.subscribe('fcm.googleapis.com');const now=Date.now();
  ctx.store.enqueueNotification({kind:'instant',title:'Done',body:'Done'},{at:now});
  ctx.store.claimPushDeliveries(now);
  const sender=ctx.restart();await sender.tick(now+119999);assert.equal(ctx.calls.length,0);
  await sender.tick(now+120000);assert.equal(ctx.calls.length,1);
}));

test('DND delays ordinary recovery while Instant notifications continue',()=>fixture(async ctx=>{
  ctx.subscribe('fcm.googleapis.com');
  ctx.store.updateSettings({dndEnabled:true,dndStart:'00:00',dndEnd:'08:00',timeZone:'UTC'});
  const now=Date.parse('2026-10-24T07:50:00Z');
  ctx.store.enqueueNotification({kind:'batch',title:'Ordinary',body:'Done'},{at:now});
  ctx.store.enqueueNotification({kind:'instant',title:'Instant',body:'Done'},{at:now});
  const sender=ctx.scheduler();await sender.tick(now);
  assert.deepEqual(ctx.calls.map(c=>c.payload.kind),['instant']);
  assert.deepEqual(ctx.broadcasts.map(c=>c.data.kind),['instant']);
  await sender.tick(Date.parse('2026-10-24T08:00:00Z'));
  assert.equal(ctx.calls.at(-1).payload.kind,'batch');
}));

test('Approval requests bypass disabled fast mode and cannot be lost before dispatch',()=>fixture(async ctx=>{
  ctx.subscribe('fcm.googleapis.com');ctx.store.updateSettings({instantEnabled:false});
  const sid=ctx.store.session({runtime:'codex',nativeId:'approval'});
  const message=ctx.store.message({sessionId:sid,body:'Approval needed',kind:'approval',priority:'normal',externalId:'approval:1'});
  assert.equal(ctx.store.readyUnreadCount(),1);
  const sender=ctx.restart();await sender.tick();await sender.instant({...message,title:'Approval'});
  assert.equal(ctx.calls.length,1);assert.equal(ctx.broadcasts.length,1);
}));

test('Disabling Instant mid-run demotes its completion to an ordinary batch',()=>fixture(async ctx=>{
  const sid=ctx.store.session({runtime:'codex',nativeId:'toggle'});
  ctx.store.message({sessionId:sid,body:'Running',priority:'instant',runId:'run'});
  ctx.store.updateSettings({instantEnabled:false});ctx.store.completeRun(sid,'run');
  assert.equal(ctx.store.readyUnreadCount(),0);assert.equal(ctx.store.pendingNotifications().length,1);
  assert.equal(ctx.store.pendingNotifications()[0].priority,'normal');
}));

test('Completion arriving before final output does not orphan or double-queue the run',()=>fixture(async ctx=>{
  ctx.subscribe('fcm.googleapis.com');const now=Date.now();
  const sid=ctx.store.session({runtime:'codex',nativeId:'reordered'});
  ctx.store.completeRun(sid,'run',{at:now-61000});
  ctx.store.message({sessionId:sid,body:'First',runId:'run',createdAt:now-1000});
  ctx.store.message({sessionId:sid,body:'Final',runId:'run',createdAt:now});
  assert.equal(ctx.store.pendingNotifications().length,1);assert.equal(ctx.store.pendingNotifications()[0].body,'Final');
  const sender=ctx.scheduler();await sender.tick(now);
  ctx.store.message({sessionId:sid,body:'Late detail',runId:'run',createdAt:now+1});
  await sender.tick(now+1000);
  assert.equal(ctx.calls.length,1);assert.equal(ctx.store.readyUnreadCount(),1);
}));

test('Messages read after failure cancel the retry and do not show stale alerts',()=>fixture(async ctx=>{
  ctx.subscribe('fcm.googleapis.com');const now=Date.now();
  const sid=ctx.store.session({runtime:'codex',nativeId:'read'});
  const message=ctx.store.message({sessionId:sid,body:'Done',runId:'run'});
  ctx.store.completeRun(sid,'run',{at:now-61000});
  const accepted=webpush.sendNotification;
  webpush.sendNotification=async(...args)=>{await accepted(...args);throw Object.assign(new Error('offline'),{code:'ETIMEDOUT'});};
  const sender=ctx.scheduler();await sender.tick(now);
  ctx.store.readMessages([message.id]);
  await sender.tick(now+30000);
  assert.equal(ctx.calls.length,1);assert.equal(sender.lastReport().results[0].state,'cancelled');
  assert.equal(ctx.broadcasts.length,1);
  assert.equal(ctx.calls[0].payload.messageIds,undefined);
}));

test('Permanent subscription failures stop retrying; expired alerts are not replayed',()=>fixture(async ctx=>{
  ctx.subscribe('fcm.googleapis.com');
  webpush.sendNotification=async()=>{throw {statusCode:410,body:'{"reason":"Unregistered"}'};};
  const report=await ctx.scheduler().send({kind:'instant',title:'Done',body:'Done'});
  assert.equal(report.results[0].retryAt,null);assert.equal(ctx.store.subscriptions().length,0);
  const now=Date.now();ctx.store.enqueueNotification({kind:'instant',title:'Old',body:'Old'},{at:now-3600001});
  const alerts=ctx.broadcasts.length;await ctx.scheduler().tick(now);
  assert.equal(ctx.broadcasts.length,alerts);
}));

test('Rate-limited push services control the retry delay and do not receive an early retry',()=>fixture(async ctx=>{
  ctx.subscribe('fcm.googleapis.com');let attempts=0;
  webpush.sendNotification=async()=>{attempts++;throw {statusCode:429,body:'{"reason":"TooManyRequests"}',headers:{'retry-after':'120'}};};
  const sender=ctx.scheduler(),before=Date.now();
  const report=await sender.send({kind:'instant',title:'Done',body:'Done'});
  assert.ok(report.results[0].retryAt>=before+120000);
  await sender.tick(report.results[0].retryAt-1);assert.equal(attempts,1);
  await sender.tick(report.results[0].retryAt);assert.equal(attempts,2);
}));

test('Expired retry reports stop advertising another attempt',()=>fixture(async ctx=>{
  ctx.subscribe('fcm.googleapis.com');
  webpush.sendNotification=async()=>{throw Object.assign(new Error('offline'),{code:'ETIMEDOUT'});};
  const sender=ctx.scheduler();await sender.send({kind:'instant',title:'Done',body:'Done'});
  await sender.tick(Date.now()+3600001);
  assert.equal(sender.lastReport().results[0].state,'expired');
  assert.equal(sender.lastReport().results[0].retryAt,null);
}));

test('Reading before restart suppresses both stale foreground alerts and device delivery',()=>fixture(async ctx=>{
  ctx.subscribe('fcm.googleapis.com');
  const sid=ctx.store.session({runtime:'codex',nativeId:'already-read'});
  const message=ctx.store.message({sessionId:sid,body:'Done',runId:'run',priority:'instant'});
  ctx.store.completeRun(sid,'run');ctx.store.readMessages([message.id]);
  await ctx.restart().tick();
  assert.equal(ctx.calls.length,0);assert.equal(ctx.broadcasts.length,0);
}));
