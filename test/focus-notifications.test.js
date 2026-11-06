import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core.js';
import {NotificationScheduler} from '../src/notify.js';
import webpush from 'web-push';

test('focus hides completed results and unread counts until it ends',()=>{
  const dir=mkdtempSync(join(tmpdir(),'attnwall-focus-'));
  const store=new Store(join(dir,'store.db'));
  try{
    const sid=store.session({runtime:'codex',nativeId:'focus-test',title:'Test'});
    const base=Date.now()-10000;
    const complete=(run,at)=>{
      store.message({sessionId:sid,externalId:run,runId:run,body:run,createdAt:at-1});
      store.completeRun(sid,run,{at});
    };
    complete('before',base);
    store.startFocus(25,base+1000);
    complete('during',base+2000);
    assert.deepEqual(store.readyInbox().map(m=>m.body),['before']);
    assert.equal(store.readyUnreadCount(),1);
    assert.equal(store.readySessions()[0].unread,1);
    assert.equal(store.pendingBroadcasts().length,1);
    assert.equal(store.markAllRead(),1);
    assert.equal(store.readyUnreadCount(),0);
    store.stopFocus();
    assert.deepEqual(store.readyInbox().map(m=>m.body),['during']);
    assert.equal(store.readyUnreadCount(),1);
    assert.equal(store.pendingBroadcasts().length,1);
    // A delayed final output uses the original completion's focus period.
    store.completeRun(sid,'late',{at:base+2500});
    store.message({sessionId:sid,externalId:'late',runId:'late',body:'late',createdAt:base+2400});
    assert.equal(store.readyInbox().length,2);
    assert.equal(store.pendingBroadcasts().length,1);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('focus completion notifications survive restart, batch once, and handle late outputs',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'attnwall-focus-queue-'));
  const file=join(dir,'store.db'),vapidFile=join(dir,'vapid.json');
  let store=new Store(file);
  const originalSend=webpush.sendNotification,calls=[],broadcasts=[];
  webpush.sendNotification=async(_subscription,payload)=>{calls.push(JSON.parse(payload));return {statusCode:201};};
  const options={vapidFile,broadcast:(type,data)=>broadcasts.push({type,data})};
  try{
    store.saveSubscription({endpoint:'https://fcm.googleapis.com/focus-test',keys:{p256dh:'test',auth:'test'}},'test');
    const sid=store.session({runtime:'codex',nativeId:'queue-test',title:'Task'});
    const base=Date.now()-2000;
    store.startFocus(25,base);
    for(const run of ['one','two']){
      store.message({sessionId:sid,externalId:run,runId:run,body:run});
      store.completeRun(sid,run,{at:base+1000});
    }
    store.completeRun(sid,'late',{at:base+1000});
    let scheduler=new NotificationScheduler(store,options);
    await scheduler.tick();assert.equal(store.db.prepare('SELECT COUNT(*) n FROM notification_events').get().n,0);assert.equal(calls.length,0);
    store.close();store=new Store(file);scheduler=new NotificationScheduler(store,options);
    store.stopFocus();await scheduler.tick();await scheduler.tick();
    let events=store.db.prepare('SELECT payload FROM notification_events').all();
    assert.equal(events.length,1);assert.equal(JSON.parse(events[0].payload).messageIds.length,2);
    assert.equal(calls.length,1);assert.equal(broadcasts.filter(event=>event.type==='notification').length,1);
    store.message({sessionId:sid,externalId:'late',runId:'late',body:'late'});
    await scheduler.tick();await scheduler.tick();
    events=store.db.prepare('SELECT payload FROM notification_events').all();
    assert.equal(events.length,2);assert.equal(JSON.parse(events[1].payload).messageIds.length,1);
    assert.equal(calls.length,2);
  }finally{webpush.sendNotification=originalSend;store.close();rmSync(dir,{recursive:true,force:true});}
});
test('upgrade recovers an unread result from the latest already-ended focus',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'attnwall-focus-upgrade-'));
  const file=join(dir,'store.db');let store=new Store(file);
  try{
    const sid=store.session({runtime:'codex',nativeId:'upgrade',title:'Task'});
    const base=Date.now()-10000;
    store.startFocus(1,base);
    store.message({sessionId:sid,externalId:'result',runId:'run',body:'result'});
    store.completeRun(sid,'run',{at:base+1000});
    store.stopFocus();
    store.db.exec('ALTER TABLE messages DROP COLUMN focus_held');
    store.close();store=new Store(file);
    assert.equal(store.db.prepare('SELECT focus_held FROM messages').get().focus_held,1);
    const scheduler=new NotificationScheduler(store,{vapidFile:join(dir,'vapid.json')});
    await scheduler.tick();await scheduler.tick();
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM notification_events').get().n,1);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
import {spawn} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import net from 'node:net';
import {setTimeout as wait} from 'node:timers/promises';
import {chromium} from 'playwright-core';
const chrome=process.env.ATTNWALL_CHROME||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome');
test('focus controls and connector completions work through the real server', {skip:!existsSync(chrome)},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'attnwall-focus-ui-'));
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));
  const port=socket.address().port;await new Promise(r=>socket.close(r));
  const origin='http://127.0.0.1:'+port;
  const child=spawn(process.execPath,[resolve('src/server.js')],{cwd:dir,env:{...process.env,ATTNWALL_PORT:String(port),ATTNWALL_LOCAL_CONNECTOR:'0'},stdio:'ignore',windowsHide:true});
  let browser;
  try{
    let ready=false;for(let i=0;i<70;i++){try{if((await fetch(origin+'/api/health')).ok){ready=true;break;}}catch{}await wait(100);}
    assert.ok(ready);
    const secrets=JSON.parse(readFileSync(join(dir,'.data','secrets.json'),'utf8'));
    browser=await chromium.launch({executablePath:chrome,headless:true});
    const page=await browser.newPage();await page.goto(origin);
    await page.locator('#access-token').fill(secrets.accessToken);await page.locator('#login-form button').click();
    await page.locator('#focus-start').waitFor();await page.locator('#focus-start').click();
    await page.locator('#focus-stop').waitFor();
    const sync=async(run)=>{
      const res=await fetch(origin+'/api/connector/sync',{method:'POST',headers:{Authorization:'Bearer '+secrets.connectorToken,'Content-Type':'application/json'},body:JSON.stringify({host:'test',sessions:[{runtime:'codex',nativeId:'task',title:'Task'}],messages:[{runtime:'codex',nativeId:'task',externalId:run,runId:run,body:run}],completions:[{runtime:'codex',nativeId:'task',runId:run}]})});assert.equal(res.status,200);
    };
    await sync('quiet-result');await wait(500);
    assert.equal(await page.getByText('quiet-result').count(),0);
    assert.equal(await page.locator('#unread-count').innerText(),'0');
    await page.locator('#focus-stop').click();await page.locator('#focus-start').waitFor();
    await page.getByText('quiet-result').first().waitFor();
    await sync('notified-result');await page.getByText('notified-result').first().waitFor();
    await page.locator('#focus-start').click();await page.locator('#focus-stop').waitFor();
    const store=new Store(join(dir,'.data','attnwall.db'));
    try{
      // Shorten the active interval to exercise automatic expiry without a minute-long test.
      store.db.prepare('UPDATE focus_periods SET ends_at=? WHERE ends_at>?').run(Date.now()+2500,Date.now());
      await page.reload();await page.locator('#focus-stop').waitFor();
      await sync('expired-result');await wait(300);
      assert.equal(await page.getByText('expired-result').count(),0);
      await page.getByText('expired-result').first().waitFor({timeout:8000});
      let count=0;for(let i=0;i<50;i++){count=store.db.prepare('SELECT COUNT(*) n FROM notification_events').get().n;if(count===3)break;await wait(200);}
      assert.equal(count,3,'manual stop, outside focus and natural expiry each produce a notification');
      assert.equal(store.readyInbox().length,3);
    }finally{store.close();}
  }finally{await browser?.close();child.kill();await wait(300);rmSync(dir,{recursive:true,force:true});}
});
