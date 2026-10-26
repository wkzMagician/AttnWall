import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright-core';import { DatabaseSync } from 'node:sqlite';

const chrome=process.env.ATTNWALL_CHROME || (process.platform==='win32'?
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome');
const available=existsSync(chrome);
async function port(){
  const server=net.createServer();
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const n=server.address().port;await new Promise(r=>server.close(r));return n;
}
test('Chrome E2E: inbox, mark all (>100), session, history, pagination, reply, Instant, navigation', {skip:!available}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'attnwall-ui-')),n=await port();
  const origin='http://127.0.0.1:'+n;
  const child=spawn(process.execPath,[resolve('src/server.js')],{
    cwd:dir,env:{...process.env,ATTNWALL_PORT:String(n),ATTNWALL_LOCAL_CONNECTOR:'0'},
    stdio:'ignore',windowsHide:true
  });
  let browser;
  try{
    let ready=false;
    for(let attempt=0;attempt<70;attempt++){
      try{if((await fetch(origin+'/api/health')).ok){ready=true;break;}}catch{}
      await wait(100);
    }
    assert.ok(ready,'Server startup');
    const secrets=JSON.parse(readFileSync(join(dir,'.data/secrets.json'),'utf8'));
    const conn=async(method,path,data)=>{
      const r=await fetch(origin+path,{method,headers:{Authorization:'Bearer '+secrets.connectorToken,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
      assert.equal(r.status,200,path);
      return r.json();
    };
    const session='browser-e2e-'+Date.now();
    const oldSession='old-session-'+Date.now(),monthSession='month-session-'+Date.now();
    const day=86400000,now=Date.now();
    await conn('POST','/api/connector/sync',{host:'testhost',sessions:[
      {runtime:'codex',nativeId:session,title:'Browser testing conversation',activityAt:now},
      {runtime:'codex',nativeId:monthSession,title:'Three weeks ago',activityAt:now-20*day},
      {runtime:'codex',nativeId:oldSession,title:'Two months ago',activityAt:now-60*day}],
      messages:Array.from({length:140},(_,i)=>({runtime:'codex',nativeId:session,externalId:'unread-'+i,body:'Notification '+i,createdAt:Date.now()+i,runId:'large-run'})),
      completions:[{runtime:'codex',nativeId:session,runId:'large-run'}]});
    browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-gpu']});
    const page=await browser.newPage({viewport:{width:1350,height:900}});
    await page.addInitScript(()=>{
      window.attnwallBadgeCalls=[];
      Object.defineProperty(navigator,'setAppBadge',{configurable:true,value:async count=>window.attnwallBadgeCalls.push(['set',count])});
      Object.defineProperty(navigator,'clearAppBadge',{configurable:true,value:async()=>window.attnwallBadgeCalls.push(['clear'])});
    });
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);
    for(const size of [152,167,180,192,512]){
      const icon=await page.request.get(origin+'/icons/attnwall-coral-v1-'+size+'.png');
      assert.equal(icon.status(),200);assert.match(icon.headers()['content-type'],/image\/png/);
      const bytes=await icon.body();assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);
    }
    assert.equal(await page.locator('link[rel="apple-touch-icon"]').count(),3,'iPhone and iPad have dedicated PNG app icons');
    await page.locator('#access-token').fill(secrets.accessToken);
    await page.locator('#login-form button[type=submit]').click();
    await page.locator('#stat-queue').getByText('1').waitFor();
    assert.equal(await page.locator('.stats-grid,.focus-chip,.eyebrow,.sidebar-foot').count(),0);
    assert.equal(await page.locator('#unread-count').innerText(),'0','Pending normal messages are hidden until batch release');
    await page.waitForFunction(()=>window.attnwallBadgeCalls.some(x=>x[0]==='clear'));
    assert.equal(await page.evaluate(()=>window.attnwallBadgeCalls.some(x=>x[0]==='set')),false,'Pending messages must not set the OS badge');
    assert.equal(await page.locator('#inbox-items .inbox-card').count(),0,'No early inbox exposure during a quiet window');
    const db=new DatabaseSync(join(dir,'.data/attnwall.db'));
    try{db.prepare("UPDATE messages SET notified_at=? WHERE role='agent' AND notified_at IS NULL").run(Date.now());}finally{db.close();}
    await page.reload();
    await page.locator('#unread-count').getByText('1',{exact:true}).waitFor();
    await page.waitForFunction(()=>window.attnwallBadgeCalls.some(x=>x[0]==='set'&&x[1]===1));
    assert.equal(await page.locator('#inbox-items .inbox-card').count(),1,'One inbox card per released conversation');
    assert.match(await page.locator('#inbox-items .inbox-card').innerText(),/Notification 139/);
    assert.equal(await page.locator('#session-range').inputValue(),'7d','Default 7-day filter');
    assert.equal(await page.locator('#session-list .session-entry').count(),1,'Only recent sessions shown');
    await page.locator('#session-range').selectOption('30d');
    assert.equal(await page.locator('#session-list .session-entry').count(),2);
    await page.locator('#session-range').selectOption('all');
    assert.equal(await page.locator('#session-list .session-entry').count(),3);
    await page.reload();
    await page.waitForFunction(()=>document.querySelectorAll('#session-list .session-entry').length===3);
    assert.equal(await page.locator('#session-list .session-entry').count(),3);
    assert.equal(await page.locator('#session-range').inputValue(),'all','Filter persists after reload');
    await page.locator('#session-range').selectOption('1d');
    assert.equal(await page.locator('#session-list .session-entry').count(),1);
    await page.locator('#session-range').selectOption('7d');
    await page.locator('#session-search').fill('Two months ago');
    assert.equal(await page.locator('#session-list .session-entry').count(),1,'Global search bypasses recent-only filter');
    assert.match(await page.locator('#session-list .session-entry').first().innerText(),/Two months ago/);
    await page.locator('#session-search').fill('');
    assert.equal(await page.locator('#session-list .session-entry').count(),1);
    await page.locator('#mark-all').click();
    await page.waitForFunction(()=>document.getElementById('unread-count').textContent==='0');
    assert.equal(await page.locator('#mark-all').isVisible(),false);
    assert.equal(await page.locator('#inbox-items').innerText(),'暂无消息');
    assert.equal(await page.locator('#delivery-status').isVisible(),false);
    await page.waitForFunction(()=>window.attnwallBadgeCalls.some(x=>x[0]==='clear'));
    assert.deepEqual(await page.evaluate(()=>window.attnwallBadgeCalls.at(-1)),['clear'],'Mark all read clears the icon badge');
    await page.locator('#session-list .session-entry').first().click();
    await page.locator('#conversation-view').waitFor({state:'visible'});
    assert.match(await page.locator('#conversation-name').innerText(),/Browser testing conversation/);
    assert.equal(await page.locator('#conversation-header #instant-toggle').count(),0,'Instant mode is not in header');
    assert.equal(await page.locator('#compose #instant-toggle').count(),1,'Instant mode lives in composer');
    assert.equal(await page.locator('#instant-toggle').getAttribute('aria-pressed'),'false');
    await page.locator('#instant-toggle').click();
    await page.locator('#instant-toggle').getByText('开').waitFor();
    assert.equal(await page.locator('#instant-toggle').getAttribute('aria-pressed'),'true');
    await page.setViewportSize({width:390,height:844});
    const mobile=await page.evaluate(()=>{
      const compose=document.querySelector('#compose').getBoundingClientRect();
      const toggle=document.querySelector('#instant-toggle').getBoundingClientRect();
      const send=document.querySelector('#compose button[type=submit]').getBoundingClientRect();
      return {inside:toggle.left>=compose.left && toggle.right<=compose.right,sideBySide:toggle.right<send.left,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth};
    });
    assert.deepEqual(mobile,{inside:true,sideBySide:true,overflow:false},'iPhone width: toggle and send remain inside composer');
    await page.locator('#instant-toggle').click();
    await page.locator('#instant-toggle').getByText('关').waitFor();
    assert.equal(await page.locator('#instant-toggle').getAttribute('aria-pressed'),'false');
    await page.setViewportSize({width:1350,height:900});
    let releaseReply,observedReply;
    const heldReply=new Promise(resolve=>releaseReply=resolve),replyArrived=new Promise(resolve=>observedReply=resolve);
    await page.route('**/api/replies',async route=>{
      if(route.request().method()==='POST'&&route.request().postDataJSON().text==='Delayed reply'){
        observedReply();await heldReply;
      }
      await route.continue();
    });
    await page.locator('#compose-text').fill('Delayed reply');
    const delayedResponse=page.waitForResponse(r=>r.url().endsWith('/api/replies')&&r.status()===200);
    await page.locator('#compose button[type=submit]').click();await replyArrived;
    assert.equal(await page.locator('#compose button[type=submit]').isDisabled(),true);
    await page.locator('#compose-text').fill('Next draft');
    await page.evaluate(()=>document.getElementById('compose').dispatchEvent(new Event('submit',{cancelable:true})));
    releaseReply();await delayedResponse;
    await page.waitForFunction(()=>!document.querySelector('#compose button[type=submit]').disabled);
    assert.equal(await page.locator('#compose-text').inputValue(),'Next draft','A completed send never erases a newer draft');
    const delayedJobs=await conn('GET','/api/connector/jobs?host=testhost&history=0');
    assert.equal(delayedJobs.jobs.length,1,'A duplicate submit while sending is ignored');
    await conn('POST','/api/connector/ack',{id:delayedJobs.jobs[0].id,state:'sent'});
    await page.unroute('**/api/replies');
    await page.locator('#compose-text').fill('E2E reply, do not execute');
    await page.locator('#compose button[type=submit]').click();
    await page.getByText('E2E reply, do not execute').waitFor();
    const jobs=await conn('GET','/api/connector/jobs?host=testhost');
    assert.equal(jobs.jobs.length,1);
    assert.equal(jobs.jobs[0].native_id,session);
    assert.equal(jobs.historyRequests.length,1);
    await conn('POST','/api/connector/ack',{id:jobs.jobs[0].id,state:'sent'});
    assert.equal(await page.locator('#compose-image-label').isVisible(),true,'Native Codex exposes the image composer');
    const imageBytes=Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3]);
    await page.locator('#compose-image').setInputFiles({name:'native-image.png',mimeType:'image/png',buffer:imageBytes});
    await Promise.all([
      page.waitForResponse(r=>r.url().endsWith('/api/replies/image')&&r.status()===200),
      page.locator('#compose button[type=submit]').click()
    ]);
    const imageJobs=await conn('GET','/api/connector/jobs?host=testhost');
    assert.equal(imageJobs.jobs.length,1);
    assert.ok(imageJobs.jobs[0].attachment_id);
    const imageJob=imageJobs.jobs[0];
    const attachment=await conn('GET','/api/connector/attachment?host=testhost&id='+imageJob.id);
    assert.equal(attachment.image.data,imageBytes.toString('base64'));
    const denied=await fetch(origin+'/api/connector/attachment?host=otherhost&id='+imageJob.id,{headers:{Authorization:'Bearer '+secrets.connectorToken}});
    assert.equal(denied.ok,false,'Another host cannot read a native image');
    const unauthImage=await fetch(origin+'/api/connector/attachment?host=testhost&id='+imageJob.id);
    assert.equal(unauthImage.status,401,'Image endpoint requires connector authentication');
    await conn('POST','/api/connector/ack',{id:imageJob.id,state:'sent'});
    await conn('POST','/api/connector/sync',{host:'testhost',
      messages:[{runtime:'codex',nativeId:session,externalId:'history-user',role:'user',body:'Original user question',silent:true,createdAt:Date.now()-1000},
      {runtime:'codex',nativeId:session,externalId:'history-agent',role:'agent',body:'Original assistant answer',silent:true,createdAt:Date.now()-999}],
      historyComplete:[{sessionId:'testhost:codex:'+session}]});
    await page.getByText('Original user question').waitFor();
    await page.getByText('Original assistant answer').waitFor();
    await page.locator('#history-older').waitFor({state:'visible'});
    await page.locator('#history-older').click();
    await page.locator('.conversation-messages .message').nth(9).waitFor();
    assert.equal(await page.locator('.conversation-messages .message').count(),10);
    await page.locator('#inbox-nav').click();
    await page.locator('#inbox-view').waitFor({state:'visible'});
    assert.equal(new URL(page.url()).searchParams.get('session'),null);
    await conn('POST','/api/connector/sync',{host:'testhost',messages:[{
      runtime:'codex',nativeId:oldSession,externalId:'ancient-unread',body:'Old conversation needs attention',
      createdAt:now-60*day+10000}]});
    const oldDb=new DatabaseSync(join(dir,'.data/attnwall.db'));
    try{oldDb.prepare("UPDATE messages SET notified_at=? WHERE session_id=? AND notified_at IS NULL").run(Date.now(),'testhost:codex:'+oldSession);}finally{oldDb.close();}
    await page.reload();
    await page.getByText('Old conversation needs attention').waitFor();
    await page.locator('#inbox-items .inbox-card').first().click();
    await page.locator('#conversation-view').waitFor({state:'visible'});
    assert.match(await page.locator('#conversation-name').innerText(),/Two months ago/);
    assert.equal(await page.locator('#session-range').inputValue(),'7d');
    assert.equal(await page.locator('#session-list .session-entry').count(),2,'Selected old session is pinned despite time filter');
    await page.locator('#session-search').fill('Two months ago');
    assert.equal(await page.locator('#session-list .session-entry').count(),1,'Selected session is not duplicated in search');
    await page.locator('#session-search').fill('');
    await page.locator('#inbox-nav').click();
    assert.equal(await page.locator('#session-list .session-entry').count(),1,'Old session hidden again after leaving');
    await page.locator('#settings-button').click();
    await page.locator('#settings-view').waitFor({state:'visible'});
    assert.equal(await page.locator('.push-diagnostics').getAttribute('open'),null);
    assert.equal(await page.locator('.browser-onboarding').getAttribute('open'),null);
    await page.locator('#time-zone').fill('');
    await page.locator('#dnd-enabled').uncheck();
    assert.equal(await page.locator('#dnd-schedule').isVisible(),false);
    await page.locator('#instant-enabled').uncheck();
    await page.locator('#interval').fill('15');
    await page.locator('#settings-form button[type=submit]').click();
    await page.getByText('已保存').waitFor();
    const saved=await page.evaluate(async()=> (await (await fetch('/api/state')).json()).settings);
    assert.equal(saved.intervalMin,15);assert.equal(saved.dndEnabled,false);assert.equal(saved.instantEnabled,false);
    await page.locator('#instant-enabled').check();
    await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/settings')&&r.status()===200),page.locator('#settings-form button[type=submit]').click()]);
    await page.locator('#attach-button').click();await page.locator('[data-add-source="codex"]').click();
    await page.locator('#codex-create-dialog').waitFor({state:'visible'});
    await page.locator('#codex-create-name').fill('Created Codex task');
    await page.locator('#codex-create-host').fill('testhost');
    await page.locator('#codex-create-cwd').fill('D:\\CodexWorkspace');
    const creationResponse=page.waitForResponse(r=>r.url().endsWith('/api/sessions/new-codex')&&r.status()===202);
    await page.locator('#codex-create-form button[type=submit]').click();
    const creation=(await (await creationResponse).json()).request;
    assert.equal(await page.locator('#session-list').getByText('Created Codex task').count(),0,'No placeholder thread');
    const claimedCreation=await conn('GET','/api/connector/jobs?host=testhost&history=0');
    assert.equal(claimedCreation.createRequests.length,1);
    await conn('POST','/api/connector/sync',{host:'testhost',creations:[{id:creation.id,nativeId:'created-native-id',cwd:'D:\\CodexWorkspace'}]});
    await page.locator('#conversation-name').getByText('Created Codex task').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('session'),'testhost:codex:created-native-id');
    await page.locator('#compose-text').fill('First created thread prompt');
    const createdReplyResponse=page.waitForResponse(r=>r.url().endsWith('/api/replies')&&r.status()===200);
    await page.locator('#compose button[type=submit]').click();await createdReplyResponse;
    const createdReplies=await conn('GET','/api/connector/jobs?host=testhost&history=0');
    assert.equal(createdReplies.jobs.length,1);assert.equal(createdReplies.jobs[0].native_id,'created-native-id');
    await conn('POST','/api/connector/ack',{id:createdReplies.jobs[0].id,state:'sent'});
    const cfg=await conn('GET','/api/connector/jobs?host=testhost');
    assert.ok(Array.isArray(cfg.jobs));
    await page.locator('#attach-button').click();
    await page.locator('#add-source-dialog').waitFor({state:'visible'});
    assert.equal(await page.locator('#attach-dialog').isVisible(),false,'Adding a session never assumes DSH');
    await page.locator('[data-add-source="web"]').click();
    await page.locator('.browser-onboarding').waitFor({state:'visible'});
    assert.equal(await page.locator('.browser-onboarding').getAttribute('open'),'');
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.copiedConfig=JSON.parse(value);}}}));
    await page.locator('#copy-browser-config').click();
    await page.locator('#browser-config-feedback').getByText('已复制').waitFor();
    assert.equal(await page.evaluate(()=>window.copiedConfig.hub),origin);
    assert.equal(await page.evaluate(()=>typeof window.copiedConfig.browserToken),'string');
    await page.locator('#attach-button').click();
    await page.locator('[data-add-source="dsh"]').click();
    await page.locator('#attach-dialog').waitFor({state:'visible'});
    await page.locator('#new-dsh-id').fill('ui-attached-session');
    await page.locator('#new-dsh-title').fill('Demo DSH');
    await page.locator('#attach-form button[type=submit]').click();
    await page.locator('#conversation-view').waitFor({state:'visible'});
    assert.match(await page.locator('#conversation-name').innerText(),/Demo DSH/);
    assert.equal(await page.locator('#instant-toggle').isVisible(),true);
    assert.equal(await page.locator('#compose button[type=submit]').isDisabled(),true);
    await page.locator('#settings-button').click();await page.locator('#logout').click();
    await page.locator('#login').waitFor({state:'visible'});
    assert.deepEqual(errors,[],'No uncaught browser errors');
  }finally{
    await browser?.close();
    child.kill();
    if(child.exitCode===null)await Promise.race([new Promise(r=>child.once('exit',r)),wait(3000)]);
    rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:150});
  }
});
