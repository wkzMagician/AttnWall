import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright-core';
import {setTimeout as wait} from 'node:timers/promises';
// Google Chrome Stable can ignore --load-extension. Use Playwright Chromium
// for MV3 tests, automatically when its official browser bundle is installed.
const chrome=process.env.ATTNWALL_CHROME||chromium.executablePath();
const enabled=process.env.ATTNWALL_TEST_EXTENSION!=='0'&&existsSync(chrome);
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
test('Actual unpacked MV3 extension: web DOM -> hub -> reply', {skip:!enabled,timeout:125000},async()=>{
  const work=mkdtempSync(join(tmpdir(),'aw-ext-test-')),profile=mkdtempSync(join(tmpdir(),'aw-profile-'));
  const n=await port(),hub='http://127.0.0.1:'+n;
  const extension=resolve('extensions/browser');
  const proc=spawn(process.execPath,[resolve('src/server.js')],{cwd:work,env:{...process.env,ATTNWALL_PORT:String(n),ATTNWALL_LOCAL_CONNECTOR:'0'},stdio:'ignore',windowsHide:true});
  let context;
  try{
    let ready=false;
    for(let i=0;i<70;i++){try{if((await fetch(hub+'/api/health')).ok){ready=true;break;}}catch{}await wait(100);}
    assert.ok(ready);
    const secrets=JSON.parse(readFileSync(join(work,'.data/secrets.json'),'utf8'));
    context=await chromium.launchPersistentContext(profile,{executablePath:chrome,headless:process.env.ATTNWALL_HEADFUL!=='1',args:[
      '--no-sandbox','--disable-extensions-except='+extension,'--load-extension='+extension
    ]});
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:12000});
    assert.match(worker.url(),/^chrome-extension:/);
    await worker.evaluate(async config=>chrome.storage.local.set(config),{hub,key:secrets.browserToken,enabled:true});
    const page=await context.newPage();
    const html='<!doctype html><html><body><main><div class="fbb737a4">Initial user</div><div class="ds-markdown">Initial reply</div><form><textarea style="width:260px;height:50px"></textarea><button aria-label="Send" type="submit">Send</button></form></main><script>window.sent="";document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.sent=document.querySelector("textarea").value;document.querySelector("textarea").value="";});</script></body></html>';
    await context.route('https://chat.deepseek.com/**',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
    await page.goto('https://chat.deepseek.com/a/chat/s/abc12345');
    const getState=async()=>{
      const res=await fetch(hub+'/api/state',{headers:{Authorization:'Bearer '+secrets.accessToken}});
      return res.json();
    };
    let matched;
    for(let i=0;i<36;i++){
      const data=await getState();
      matched=data.sessions.find(s=>s.runtime==='deepseek-web');
      if(matched)break;
      await wait(500);
    }
    assert.ok(matched,'Web session synced through actual extension');
    let baselineReady=false;
    for(let i=0;i<28;i++){
      const response=await fetch(hub+'/api/messages?sessionId='+encodeURIComponent(matched.id),{headers:{Authorization:'Bearer '+secrets.accessToken}});
      const data=await response.json();
      if(data.messages?.length>=2){baselineReady=true;break;}
      await wait(500);
    }
    assert.equal(baselineReady,true,'Initial historical DOM sync fully completed');
    assert.equal((await getState()).unreadCount,0,'First visible history silent');
    assert.equal((await getState()).nextBatchAt,null,'Historical messages must not start a timer');
    const startedAt=Date.now();
    await page.evaluate(()=>{
      const form=document.querySelector('form'),main=document.querySelector('main');
      const user=document.createElement('div');user.className='fbb737a4';user.textContent='A new turn';main.insertBefore(user,form);
      const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='Stop';main.append(stop);
    });
    // The collector must witness the generation signal, rather than infer a
    // completed run merely from the presence of an idle assistant message.
    await wait(4200);
    const firstDeadline=(await getState()).nextBatchAt;
    assert.ok(firstDeadline>=startedAt+20*60000&&firstDeadline<=Date.now()+20*60000,'Streaming task starts the timer before completion');
    assert.equal((await getState()).queuedNormal,0,'An active task has no completed output to release');
    await page.evaluate(()=>{
      document.querySelector('[data-testid="stop-button"]').remove();
      const el=document.createElement('div');el.className='ds-markdown';el.textContent='New assistant response';document.querySelector('main').insertBefore(el,document.querySelector('form'));
    });
    let got=false;
    for(let i=0;i<45;i++){if((await getState()).queuedNormal>0){got=true;break;}await wait(500);}
    if(!got){
      const status=await worker.evaluate(()=>chrome.storage.local.get('bridgeStatus'));
      const current=await getState();
      console.log('E2E debug',JSON.stringify({status:status.bridgeStatus,queued:current.queuedNormal,sessions:current.sessions.length}));
    }
    assert.equal(got,true,'New web assistant message enters delayed notification queue');
    assert.equal((await getState()).nextBatchAt,firstDeadline,'Finishing must preserve the start-based deadline');
    const r=await fetch(hub+'/api/replies',{method:'POST',headers:{Authorization:'Bearer '+secrets.accessToken,'Content-Type':'application/json'},body:JSON.stringify({sessionId:matched.id,text:'Follow up via AttnWall'})});
    assert.equal(r.status,200);
    await page.waitForFunction(()=>window.sent==='Follow up via AttnWall',{timeout:16000});
    assert.equal(await page.evaluate(()=>window.sent),'Follow up via AttnWall');
    let acknowledged=false;
    for(let i=0;i<40;i++){
      const detail=await fetch(hub+'/api/messages?sessionId='+encodeURIComponent(matched.id),{headers:{Authorization:'Bearer '+secrets.accessToken}}).then(r=>r.json());
      if(detail.replies?.some(x=>x.state==='sent'&&x.text==='Follow up via AttnWall')){acknowledged=true;break;}
      await wait(250);
    }
    assert.equal(acknowledged,true,'First reply has an acknowledged send before its tab closes');
    // Close the original tab: the extension must recover the saved exact URL and
    // reopen it on a background alarm instead of losing the reply.
    await page.close();
    const reopenedPromise=context.waitForEvent('page',{timeout:65000});
    const second=await fetch(hub+'/api/replies',{method:'POST',headers:{Authorization:'Bearer '+secrets.accessToken,'Content-Type':'application/json'},body:JSON.stringify({sessionId:matched.id,text:'Reply to closed original tab'})});
    assert.equal(second.status,200);
    const reopened=await reopenedPromise;
    await reopened.waitForURL('https://chat.deepseek.com/a/chat/s/abc12345',{timeout:18000});
    try{await reopened.waitForFunction(()=>window.sent==='Reply to closed original tab',{timeout:23000});}
    catch(e){
      const detail=await fetch(hub+'/api/messages?sessionId='+encodeURIComponent(matched.id),{headers:{Authorization:'Bearer '+secrets.accessToken}}).then(r=>r.json());
      const status=await worker.evaluate(()=>chrome.storage.local.get('bridgeStatus')).catch(()=>({}));
      console.log('Closed-tab debug',JSON.stringify({url:reopened.url(),composer:await reopened.locator('textarea').count(),replyStates:(detail.replies||[]).map(r=>({state:r.state,error:r.error})),bridge:status.bridgeStatus}));
      throw e;
    }
    assert.equal(await reopened.evaluate(()=>window.sent),'Reply to closed original tab');
    // Also run the real extension + hub with a synthetic ChatGPT SPA route
    // transition. Previous-page DOM must never enter the next conversation.
    const chatA='https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const chatB='https://chatgpt.com/c/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const chatHtml='<!doctype html><head><title>Chat A</title></head><body>'+
      '<nav><div data-chatgpt-search-unit-key="old:user" data-role="user">Outside chat search history</div></nav>'+
      '<main><article data-message-author-role="user">Synthetic question A</article>'+
      '<article data-message-author-role="assistant"><div class="markdown">Synthetic answer A</div></article></main></body>';
    await context.route('https://chatgpt.com/**',route=>route.fulfill({status:200,contentType:'text/html',body:chatHtml}));
    const chat=await context.newPage();
    await chat.goto('https://chatgpt.com/');
    await chat.evaluate(url=>history.pushState({},'',url),chatA);
    let chatSession;
    for(let i=0;i<38;i++){
      const state=await getState();
      chatSession=state.sessions.find(s=>s.runtime==='chatgpt-web'&&s.native_id==='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      if(chatSession){
        const msgs=await fetch(hub+'/api/messages?sessionId='+encodeURIComponent(chatSession.id),{headers:{Authorization:'Bearer '+secrets.accessToken}}).then(r=>r.json());
        if(msgs.messages?.length===2)break;
      }
      await wait(400);
    }
    assert.ok(chatSession,'Real MV3 extension must sync synthetic ChatGPT conversation');
    await chat.evaluate(url=>history.pushState({},'',url),chatB);
    await wait(4600);
    assert.equal((await getState()).sessions.some(s=>s.runtime==='chatgpt-web'&&s.native_id==='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),false,
      'Old ChatGPT page DOM cannot register messages under a new URL');
    await chat.evaluate(()=>{document.title='Chat B';document.querySelector('main').innerHTML=
      '<article data-message-author-role="user">Synthetic question B</article>'+
      '<article data-message-author-role="assistant"><div class="markdown">Synthetic answer B</div></article>';});
    let cleanB=false;
    for(let i=0;i<40;i++){
      const state=await getState();
      const target=state.sessions.find(s=>s.runtime==='chatgpt-web'&&s.native_id==='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
      if(target){
        const msgs=await fetch(hub+'/api/messages?sessionId='+encodeURIComponent(target.id),{headers:{Authorization:'Bearer '+secrets.accessToken}}).then(r=>r.json());
        if(msgs.messages?.length===2){
          assert.deepEqual(msgs.messages.map(m=>m.body),['Synthetic question B','Synthetic answer B']);
          assert.ok(msgs.messages.every(m=>m.read_at!==null),'B initial history should be silent');
          cleanB=true;break;
        }
      }
      await wait(400);
    }
    assert.equal(cleanB,true,'ChatGPT history must remain isolated across SPA transitions');
    // Large pages must return a small recent window during history requests.
    await chat.evaluate(()=>{
      document.querySelector('main').innerHTML=Array.from({length:140},(_,i)=>
        '<article data-message-id="history-'+i+'" data-message-author-role="'+(i%2?'assistant':'user')+'">Long history '+i+'</article>').join('');
    });
    const bSession=(await getState()).sessions.find(s=>s.native_id==='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    const requested=await fetch(hub+'/api/sessions/history',{method:'POST',headers:{Authorization:'Bearer '+secrets.accessToken,'Content-Type':'application/json'},body:JSON.stringify({sessionId:bSession.id,force:true})});
    assert.equal(requested.status,200);
    await worker.evaluate(()=>chrome.alarms.create('attnwall-poll',{when:Date.now()+100}));
    let fullHistory=false;
    for(let i=0;i<70;i++){
      const detail=await fetch(hub+'/api/messages?sessionId='+encodeURIComponent(bSession.id)+'&limit=300',{headers:{Authorization:'Bearer '+secrets.accessToken}}).then(r=>r.json());
      if(detail.history?.state==='complete'){
        const imported=detail.messages.filter(m=>m.body.startsWith('Long history '));
        assert.equal(imported.length,5);assert.ok(imported.every(m=>m.read_at!==null));
        fullHistory=true;break;
      }
      await wait(400);
    }
    assert.ok(fullHistory,'MV3 history request must finish with a bounded recent window');

  }finally{
    await context?.close();
    proc.kill();
    if(proc.exitCode===null)await Promise.race([new Promise(r=>proc.once('exit',r)),wait(3000)]);
    rmSync(work,{recursive:true,force:true,maxRetries:12,retryDelay:100});
    rmSync(profile,{recursive:true,force:true,maxRetries:12,retryDelay:100});
  }
});
