import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import net from 'node:net';
import {setTimeout as wait} from 'node:timers/promises';
import {runInNewContext} from 'node:vm';
import {chromium} from 'playwright-core';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/core.js';

const deviceA='remote-device-aaaa-1234',deviceB='remote-device-bbbb-1234';
const chrome=process.env.ATTNWALL_CHROME||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome');

test('Remote queues survive push expiry and restart until each device independently confirms',()=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-remote-store-')),path=join(dir,'store.db');
  let store=new Store(path);
  try{
    const now=Date.now();
    store.syncRemote(deviceA,{now});store.syncRemote(deviceB,{now});
    store.enqueueNotification({kind:'batch',title:'First',body:'A'}, {id:'event-a',at:now+1});
    store.enqueueNotification({kind:'instant',title:'Second',body:'B'}, {id:'event-b',at:now+2});
    store.enqueueNotification({kind:'test',title:'Test'}, {id:'test-only',at:now+3,broadcast:false});
    assert.deepEqual(store.syncRemote(deviceA).rows.map(row=>row.event_id),['event-a','event-b']);
    assert.equal(store.acknowledgeRemote(deviceA,['event-a']),1);
    assert.equal(store.acknowledgeRemote(deviceA,['event-a']),0,'A lost ACK response is safe to retry');
    assert.equal(store.acknowledgeRemote('another-remote-device',['event-b']),0);
    store.claimPushDeliveries(now+10*86400000);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM notification_events').get().n,0,'Push event retention has expired');
    store.close();store=new Store(path);
    assert.deepEqual(store.syncRemote(deviceA).rows.map(row=>row.event_id),['event-b']);
    assert.deepEqual(store.syncRemote(deviceB).rows.map(row=>row.event_id),['event-a','event-b']);
    assert.deepEqual(store.syncRemote(deviceB,{allowBatch:false}).rows.map(row=>row.event_id),['event-b']);
    assert.equal(store.acknowledgeRemote(deviceB,['event-a','event-b']),2);
    assert.equal(store.syncRemote(deviceB).rows.length,0);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('Remote sync paginates without losing events when acknowledgments are delayed',()=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-remote-pages-')),store=new Store(join(dir,'store.db'));
  try{
    store.syncRemote(deviceA);
    for(let i=0;i<65;i++)store.enqueueNotification({kind:'instant',title:String(i)}, {id:'event-'+String(i).padStart(3,'0'),at:Date.now()+i});
    const first=store.syncRemote(deviceA);assert.equal(first.rows.length,50);assert.equal(first.hasMore,true);
    assert.deepEqual(store.syncRemote(deviceA).rows.map(row=>row.event_id),first.rows.map(row=>row.event_id));
    store.acknowledgeRemote(deviceA,first.rows.map(row=>row.event_id));
    const second=store.syncRemote(deviceA);assert.equal(second.rows.length,15);assert.equal(second.hasMore,false);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('A newly registered remote recovers retained unread events created before it connected',()=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-remote-first-')),store=new Store(join(dir,'store.db'));
  try{
    const sid=store.session({runtime:'codex',nativeId:'first-device'});
    const unread=store.message({sessionId:sid,externalId:'unread',body:'Still needed',kind:'userInput'});
    const alreadyRead=store.message({sessionId:sid,externalId:'read',body:'Already seen',kind:'userInput'});
    store.readMessages([alreadyRead.id]);
    const pending=store.syncRemote(deviceA).rows.map(row=>JSON.parse(row.payload));
    assert.equal(pending.length,1);assert.deepEqual(pending[0].messageIds,[unread.id]);
    store.acknowledgeRemote(deviceA,[pending[0].notificationId]);
    assert.equal(store.syncRemote(deviceA).rows.length,0,'Registration does not backfill again after acknowledgment');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

async function freePort(){
  const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
async function withServer(run){
  const dir=mkdtempSync(join(tmpdir(),'aw-remote-http-')),port=await freePort(),origin='http://127.0.0.1:'+port;
  const child=spawn(process.execPath,[resolve('src/server.js')],{cwd:dir,env:{...process.env,ATTNWALL_PORT:String(port),ATTNWALL_LOCAL_CONNECTOR:'0'},stdio:'ignore',windowsHide:true});
  try{
    let ready=false;
    for(let i=0;i<100;i++){try{if((await fetch(origin+'/api/health')).ok){ready=true;break;}}catch{}await wait(100);}
    assert.ok(ready,'Server started');
    const secrets=JSON.parse(readFileSync(join(dir,'.data/secrets.json'),'utf8'));
    const request=async(path,data,token=secrets.accessToken)=>{
      const response=await fetch(origin+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(data)});
      return {status:response.status,data:await response.json()};
    };
    await run({dir,origin,secrets,request});
  }finally{
    child.kill();if(child.exitCode===null)await Promise.race([new Promise(resolve=>child.once('exit',resolve)),wait(3000)]);
    rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}

test('Authenticated reconnect sends only unconfirmed, still-unread events to that device',()=>withServer(async c=>{
  assert.equal((await c.request('/api/remote/sync',{deviceId:deviceA},'wrong-token')).status,401);
  assert.equal((await c.request('/api/remote/sync',{deviceId:'bad'})).status,400);
  assert.deepEqual((await c.request('/api/remote/sync',{deviceId:deviceA})).data.events,[]);
  await c.request('/api/remote/sync',{deviceId:deviceB});
  const response=await c.request('/api/connector/sync',{host:'remote-test',sessions:[{runtime:'codex',nativeId:'conversation'}],
    messages:[{runtime:'codex',nativeId:'conversation',externalId:'input-1',kind:'userInput',body:'Needs attention'}]},c.secrets.connectorToken);
  assert.equal(response.status,200);
  const first=(await c.request('/api/remote/sync',{deviceId:deviceA})).data.events;
  assert.equal(first.length,1);assert.equal(first[0].body,'Needs attention');
  assert.equal((await c.request('/api/remote/sync',{deviceId:deviceA})).data.events.length,1,'No ACK means replay');
  assert.equal((await c.request('/api/remote/ack',{deviceId:deviceA,ids:[first[0].notificationId]})).data.acknowledged,1);
  assert.equal((await c.request('/api/remote/ack',{deviceId:deviceA,ids:[first[0].notificationId]})).data.acknowledged,0);
  assert.equal((await c.request('/api/remote/sync',{deviceId:deviceA})).data.events.length,0);
  assert.equal((await c.request('/api/remote/sync',{deviceId:deviceB})).data.events.length,1);
  await c.request('/api/messages/read-all',{});
  assert.equal((await c.request('/api/remote/sync',{deviceId:deviceB})).data.events.length,0,'Do not replay globally read alerts');
}));

test('Reconnect respects quiet hours for batch events while allowing instant events',()=>withServer(async c=>{
  await c.request('/api/remote/sync',{deviceId:deviceA});
  const date=new Date(),minute=date.getUTCHours()*60+date.getUTCMinutes();
  const clock=offset=>{const value=(minute+offset+1440)%1440;return String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0');};
  const settings=await c.request('/api/settings',{dndEnabled:true,dndStart:clock(-60),dndEnd:clock(60),timeZone:'UTC'});
  assert.equal(settings.status,200);
  const store=new Store(join(c.dir,'.data/attnwall.db'));
  try{
    const sid=store.session({runtime:'codex',nativeId:'quiet-hours'});
    const message=store.message({sessionId:sid,body:'Waiting for quiet hours',runId:'run'});
    store.completeRun(sid,'run');store.claimNotificationBatch();
    store.enqueueNotification({kind:'batch',title:'Batch',body:'Waiting',messageIds:[message.id]},{id:'batch-quiet'});
    store.enqueueNotification({kind:'instant',title:'Instant',body:'Urgent',messageIds:[message.id]},{id:'instant-quiet'});
    const during=(await c.request('/api/remote/sync',{deviceId:deviceA})).data.events;
    assert.deepEqual(during.map(event=>event.notificationId),['instant-quiet']);
    await c.request('/api/remote/ack',{deviceId:deviceA,ids:['instant-quiet']});
    await c.request('/api/settings',{dndEnabled:false});
    const after=(await c.request('/api/remote/sync',{deviceId:deviceA})).data.events;
    assert.deepEqual(after.map(event=>event.notificationId),['batch-quiet']);
  }finally{store.close();}
}));

test('Service worker acknowledges after displaying a push, and retains failures for reconnect',async()=>{
  const handlers={},order=[],pending=[];
  const self={navigator:{},location:{origin:'https://example.test'},registration:{async showNotification(){order.push('display');}},
    AttnWallReceipts:{async process(_notice,display){await display();return 'done';},async acknowledge(ids){order.push('ack:'+ids[0]);}},
    addEventListener(type,handler){handlers[type]=handler;}};
  runInNewContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL,Promise});
  handlers.push({data:{json:()=>({kind:'instant',notificationId:'event-1',title:'New'})},waitUntil:p=>pending.push(p)});
  await Promise.all(pending);assert.deepEqual(order,['display','ack:event-1']);
  self.registration.showNotification=async()=>{throw Error('Display failed');};
  pending.length=0;handlers.push({data:{json:()=>({kind:'instant',notificationId:'event-2',title:'New'})},waitUntil:p=>pending.push(p)});
  await Promise.all(pending);assert.deepEqual(order,['display','ack:event-1']);
});

test('A disconnected page recovers once even when its first acknowledgment is lost',
  {skip:!existsSync(chrome),timeout:45000},()=>withServer(async c=>{
    const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-gpu']});
    const context=await browser.newContext(),page=await context.newPage();
    try{
      await page.addInitScript(()=>{
        window.noticeCalls=[];
        class FakeNotification{static permission='granted';constructor(title,options){window.noticeCalls.push({title,tag:options.tag});}close(){}}
        Object.defineProperty(window,'Notification',{value:FakeNotification,configurable:true});
      });
      await page.goto(c.origin);await page.locator('#access-token').fill(c.secrets.accessToken);await page.locator('#login-form button').click();
      await page.locator('#application').waitFor({state:'visible'});
      const db=new DatabaseSync(join(c.dir,'.data/attnwall.db'),{readOnly:true});
      try{
        let registered=false;
        for(let i=0;i<100;i++){if(db.prepare('SELECT COUNT(*) n FROM remote_devices').get().n){registered=true;break;}await wait(100);}
        assert.ok(registered,'Page registered its device');
        await context.setOffline(true);
        await c.request('/api/connector/sync',{host:'remote-test',sessions:[{runtime:'codex',nativeId:'offline'}],
          messages:[{runtime:'codex',nativeId:'offline',externalId:'offline-1',kind:'userInput',body:'Recovered after disconnect'}]},c.secrets.connectorToken);
        let failedAck=false,allowState=false,stateFailures=0;
        await page.route('**/api/state',route=>{if(!allowState){stateFailures++;return route.abort('internetdisconnected');}return route.continue();});
        await page.route('**/api/remote/ack',route=>{if(!failedAck){failedAck=true;return route.abort('internetdisconnected');}return route.continue();});
        await context.setOffline(false);await page.evaluate(()=>window.dispatchEvent(new Event('online')));
        for(let i=0;i<100&&!stateFailures;i++)await wait(100);
        assert.ok(stateFailures,'A state refresh was deliberately interrupted');
        assert.equal(failedAck,false,'A receipt cannot be acknowledged before state is synchronized');
        assert.equal(await page.evaluate(()=>window.noticeCalls.length),0);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM remote_deliveries WHERE acknowledged_at IS NULL').get().n,1);
        allowState=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));
        for(let i=0;i<100&&!failedAck;i++)await wait(100);
        assert.equal(failedAck,true,'First ACK was intentionally lost');
        assert.equal(db.prepare('SELECT COUNT(*) n FROM remote_deliveries WHERE acknowledged_at IS NULL').get().n,1);
        await page.evaluate(()=>window.dispatchEvent(new Event('online')));
        let acknowledged=false;
        for(let i=0;i<100;i++){if(db.prepare('SELECT COUNT(*) n FROM remote_deliveries WHERE acknowledged_at IS NOT NULL').get().n){acknowledged=true;break;}await wait(100);}
        assert.ok(acknowledged,'Reconnect retries the ACK');
        await page.getByText('Recovered after disconnect',{exact:false}).first().waitFor({state:'visible'});
        assert.equal((await page.evaluate(()=>window.noticeCalls.length)),1,'A retried delivery is not displayed twice');
        const receipt=await page.evaluate(async()=>{
          const event={notificationId:'concurrent-receipt'};let displays=0;
          const display=async()=>{displays++;await new Promise(resolve=>setTimeout(resolve,50));};
          const results=await Promise.all([AttnWallReceipts.process(event,display),AttnWallReceipts.process(event,display)]);
          return {displays,results};
        });
        assert.equal(receipt.displays,1);assert.ok(receipt.results.includes('busy'));
        allowState=false;stateFailures=0;
        await page.reload();
        await page.locator('#application').waitFor({state:'visible'});
        await page.locator('#connection-label').waitFor({state:'visible'});
        assert.ok(stateFailures,'Startup state request was interrupted');
        allowState=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));
        await page.locator('#connection-label').waitFor({state:'hidden'});
        assert.equal(await page.locator('#login').isVisible(),false,'A transient startup outage does not require signing in again');
        const workerReady=context.waitForEvent('serviceworker');
        await page.evaluate(()=>navigator.serviceWorker.register('/sw.js'));
        const worker=await workerReady;
        const pageId=await page.evaluate(()=>AttnWallReceipts.deviceId());
        const workerId=await worker.evaluate(()=>self.AttnWallReceipts.deviceId());
        assert.equal(workerId,pageId,'The page and push worker use the same device identity');
        const [pageStatus,workerStatus]=await Promise.all([
          page.evaluate(()=>AttnWallReceipts.process({notificationId:'cross-context-event'},async()=>{
            window.crossContextDisplays=1;await new Promise(resolve=>setTimeout(resolve,150));
          })),
          worker.evaluate(()=>self.AttnWallReceipts.process({notificationId:'cross-context-event'},async()=>{
            self.crossContextDisplays=1;await new Promise(resolve=>setTimeout(resolve,150));
          }))
        ]);
        assert.ok([pageStatus,workerStatus].includes('done'));
        assert.equal((await page.evaluate(()=>window.crossContextDisplays||0))+(await worker.evaluate(()=>self.crossContextDisplays||0)),1,
          'The page and worker display the same event only once');
      }finally{db.close();}
    }finally{await context.close();await browser.close();}
  }));
