import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import {setTimeout as wait} from 'node:timers/promises';
import {chromium} from 'playwright-core';
const root=resolve('extensions/browser');
const origin='chrome-extension://'+'a'.repeat(32);
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('Extension manifest requires only supported websites and no cookie permission',()=>{
  const m=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
  assert.equal(m.manifest_version,3);
  assert.deepEqual(m.content_scripts[0].matches,[
    'https://chatgpt.com/*','https://chat.deepseek.com/*'
  ]);
  assert.equal(m.permissions.includes('cookies'),false);
  assert.equal(m.permissions.includes('webRequest'),false);
});
test('Bridge credential scoped to web conversations and original reply host',async()=>{
  const cwd=mkdtempSync(join(tmpdir(),'aw-browser-')),n=await port(),base='http://127.0.0.1:'+n;
  const child=spawn(process.execPath,[resolve('src/server.js')],{
    cwd,env:{...process.env,ATTNWALL_PORT:String(n),ATTNWALL_LOCAL_CONNECTOR:'0'},stdio:'ignore',windowsHide:true});
  try{
    let started=false;
    for(let i=0;i<75;i++){try{if((await fetch(base+'/api/health')).ok){started=true;break;}}catch{}await wait(100);}
    assert.ok(started);
    const secrets=JSON.parse(readFileSync(join(cwd,'.data/secrets.json'),'utf8'));
    assert.notEqual(secrets.browserToken,secrets.connectorToken);
    const request=async(path,token,method='GET',payload,from=path.startsWith('/api/browser/')?origin:null)=>{
      const r=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(from?{Origin:from}:{})},
        body:payload?JSON.stringify(payload):undefined});
      return {status:r.status,data:await r.json()};
    };
    const setup=await request('/api/browser/setup',secrets.accessToken);
    assert.equal(setup.status,200);
    assert.equal(setup.data.browserToken,secrets.browserToken);
    assert.equal((await request('/api/browser/setup',secrets.browserToken)).status,401);
    const host='web-1234567890abcdef';
    assert.equal((await request('/api/browser/ping',secrets.connectorToken)).status,401);
    assert.equal((await request('/api/browser/ping',secrets.browserToken)).status,200);
    assert.equal((await request('/api/state',secrets.browserToken)).status,401);
    assert.equal((await request('/api/connector/jobs?host=local',secrets.browserToken)).status,401);
    assert.equal((await request('/api/browser/ping',secrets.browserToken,'GET',null,'https://malicious.example')).status,403);
    const codex={runtime:'codex-web',nativeId:'abc123def4',url:'https://chatgpt.com/codex/cloud/tasks/abc123def4'};
    const deepseek={runtime:'deepseek-web',nativeId:'bcdefghi09',url:'https://chat.deepseek.com/a/chat/s/bcdefghi09'};
    const chatgpt={runtime:'chatgpt-web',nativeId:'6aae2ee6-a578-83ea-af71-b33479edd9ea',url:'https://chatgpt.com/g/g-p-6aae2e8158188191a1940861904284d2-example-project/c/6aae2ee6-a578-83ea-af71-b33479edd9ea'};
    const legacy=await request('/api/browser/sync',secrets.browserToken,'POST',{host,
      messages:[{...chatgpt,externalId:'dom-legacy-1234',role:'agent',body:'Wrong conversation data'}]});
    assert.equal(legacy.status,426,'Legacy unscoped ChatGPT DOM collectors are rejected');
    const r=await request('/api/browser/sync',secrets.browserToken,'POST',{host,captureVersion:2,
      sessions:[{...codex,title:'Codex Web Task'},{...deepseek,title:'DeepSeek Conversation'},
        {...chatgpt,title:'ChatGPT Project'},
        {runtime:'chatgpt-web',nativeId:'other-chat-5678',url:'https://chatgpt.com/c/other-chat-5678',title:'Discovered from sidebar'},
        {runtime:'chatgpt-web',nativeId:'bad-chat-id',url:'https://evil.com/c/bad-chat-id',title:'Spoofed link'},
        {runtime:'codex',nativeId:'native123',url:codex.url}],
      messages:[{...deepseek,title:'DeepSeek Conversation',externalId:'dom-0-abcd123',role:'agent',body:'Hello from DeepSeek',runId:'web:dom-user2345',silent:false},
        {...codex,title:'Codex Web Task',externalId:'dom-1-abcd123',role:'user',body:'User task',silent:true},
        {...codex,externalId:'dom-2-abc123',role:'agent',body:'Task completed',runId:'web:dom-user2345',silent:false},
        {...codex,externalId:'dom-3-abc123',role:'agent',body:'wrong domain',url:'https://other.com/codex/cloud/tasks/abc123def4'},
        {...chatgpt,title:'ChatGPT Project',externalId:'dom-3-chatgpt001',role:'agent',body:'ChatGPT project answer',silent:true},
        {...chatgpt,externalId:'dom-4-chatgpt001',role:'agent',body:'Spoofed project',url:'https://evil.example/c/6aae2ee6-a578-83ea-af71-b33479edd9ea'}]});
    assert.equal(r.status,200);assert.equal(r.data.added,4);
    const duplicate=await request('/api/browser/sync',secrets.browserToken,'POST',{host,messages:[{...deepseek,externalId:'dom-0-abcd123',role:'agent',body:'Hello from DeepSeek'}]});
    assert.equal(duplicate.data.added,0);
    const state=await request('/api/state',secrets.accessToken);
    assert.equal(state.data.sessions.length,4);
    assert.equal(state.data.unreadCount,0,'Pending normal web messages are not yet presented');
    assert.equal(state.data.queuedNormal,0,'No web notifications before observed completion');
    const finish=await request('/api/browser/sync',secrets.browserToken,'POST',{host,captureVersion:2,
      completions:[{...codex,runId:'web:dom-user2345'}]});
    assert.equal(finish.status,200);
    assert.equal((await request('/api/state',secrets.accessToken)).data.queuedNormal,1);
    await request('/api/browser/sync',secrets.browserToken,'POST',{host,captureVersion:2,completions:[{...codex,runId:'web:dom-user2345'}]});
    assert.equal((await request('/api/state',secrets.accessToken)).data.queuedNormal,1,'Duplicate finish cannot cause duplicate push');
    const discovered=state.data.sessions.find(x=>x.native_id==='other-chat-5678');
    assert.equal(discovered.source_url,'https://chatgpt.com/c/other-chat-5678');
    assert.equal(state.data.sessions.some(x=>x.native_id==='bad-chat-id'),false);
    const chat=state.data.sessions.find(x=>x.runtime==='chatgpt-web'&&x.native_id===chatgpt.nativeId);
    assert.equal(chat.native_id,chatgpt.nativeId);
    const chatMsgs=await request('/api/messages?sessionId='+encodeURIComponent(chat.id),secrets.accessToken);
    assert.ok(chatMsgs.data.messages.some(m=>m.body==='ChatGPT project answer'));
    assert.equal(chatMsgs.data.messages.find(m=>m.body==='ChatGPT project answer').read_at!==null,true);
    const sid=state.data.sessions.find(x=>x.runtime==='codex-web').id;
    const reply=await request('/api/replies',secrets.accessToken,'POST',{sessionId:sid,text:'Continue cloud task',id:'browser-test-reply'});
    assert.equal(reply.status,200);
    const jobs=await request('/api/browser/jobs?host='+host,secrets.browserToken);
    assert.equal(jobs.data.jobs.length,1);
    assert.equal(jobs.data.jobs[0].native_id,codex.nativeId);
    assert.equal(jobs.data.jobs[0].source_url,codex.url);
    assert.equal(jobs.data.jobs[0].runtime,'codex-web');
    assert.equal((await request('/api/browser/ack',secrets.browserToken,'POST',{host:'web-otherbrowser123',id:'browser-test-reply',state:'sent'})).status,404);
    assert.equal((await request('/api/browser/ack',secrets.browserToken,'POST',{host,id:'browser-test-reply',state:'sent'})).status,200);
    const second=await request('/api/replies',secrets.accessToken,'POST',{sessionId:chat.id,text:'ChatGPT project followup',id:'project-chat-reply'});
    assert.equal(second.status,200);
    const projectJobs=await request('/api/browser/jobs?host='+host,secrets.browserToken);
    assert.equal(projectJobs.data.jobs.length,1);
    assert.equal(projectJobs.data.jobs[0].native_id,chatgpt.nativeId);
    assert.equal(projectJobs.data.jobs[0].runtime,'chatgpt-web');
    assert.equal((await request('/api/browser/ack',secrets.browserToken,'POST',{host,id:'project-chat-reply',state:'sent'})).status,200);
    const png=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]).toString('base64');
    const imageUpload=await request('/api/replies/image',secrets.accessToken,'POST',{
      sessionId:chat.id,text:'Please review the screenshot',id:'chatgpt-web-photo',
      image:{type:'image/png',name:'screen.png',data:png}
    });
    assert.equal(imageUpload.status,200);
    assert.equal((await request('/api/replies/image',secrets.browserToken,'POST',{sessionId:chat.id,text:'no access'})).status,401);
    const photoJobs=await request('/api/browser/jobs?host='+host,secrets.browserToken);
    assert.equal(photoJobs.data.jobs.length,1);
    assert.ok(photoJobs.data.jobs[0].attachment_id);
    const photoPath='/api/browser/attachment?host='+encodeURIComponent(host)+'&replyId=chatgpt-web-photo';
    assert.equal((await request(photoPath,secrets.connectorToken)).status,401);
    assert.equal((await request('/api/browser/attachment?host=web-otherbrowser123&replyId=chatgpt-web-photo',secrets.browserToken)).status,400);
    const photo=await request(photoPath,secrets.browserToken);
    assert.equal(photo.status,200);
    assert.equal(photo.data.image.data,png);
    assert.equal((await request('/api/browser/ack',secrets.browserToken,'POST',{host,id:'chatgpt-web-photo',state:'sent'})).status,200);
    assert.equal((await request(photoPath,secrets.browserToken)).status,400);
    const history=await request('/api/messages?sessionId='+encodeURIComponent(sid),secrets.accessToken);
    assert.ok(history.data.messages.some(m=>m.role==='user'&&m.body==='Continue cloud task'));
  }finally{
    child.kill();
    if(child.exitCode===null)await Promise.race([new Promise(r=>child.once('exit',r)),wait(3000)]);
    rmSync(cwd,{recursive:true,force:true,maxRetries:10,retryDelay:150});
  }
});
const chrome=process.env.ATTNWALL_CHROME||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome');
test('Browser DOM adapters: exact routes, conversation messages, safe send and draft preservation',{skip:!existsSync(chrome)},async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-gpu']});
  try{
    for(const entry of [
      {url:'https://chat.deepseek.com/a/chat/s/bcdefghi09',body:'<div class="fbb737a4">DeepSeek user</div><div class="ds-markdown">DeepSeek assistant</div>'},
      {url:'https://chatgpt.com/codex/cloud/tasks/abc123def4',body:'<div data-role="user">Codex user</div><div data-role="assistant">Codex assistant</div>'},
      {url:'https://chatgpt.com/c/6aae2ee6-a578-83ea-af71-b33479edd9ea',body:'<article data-message-author-role="user"><div class="whitespace-pre-wrap">ChatGPT user</div></article><article data-message-author-role="assistant"><div class="markdown">ChatGPT answer</div><button>Copy</button></article>'},
      {url:'https://chatgpt.com/g/g-p-6aae2e8158188191a1940861904284d2-unpaired-majorana-fermions/c/6aae2ee6-a578-83ea-af71-b33479edd9ea',body:'<article data-message-id="user1" data-message-author-role="user"><div class="whitespace-pre-wrap">Project question</div></article><article data-message-id="agent1" data-message-author-role="assistant"><div class="markdown">Project answer</div><div>Copy not part of answer</div></article>'}
    ]){
      const page=await browser.newPage();
      await page.route('**/*',r=>r.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><body><main><section>'+entry.body+'</section><form><textarea></textarea><button type="submit" aria-label="Send">Send</button></form></main><script>document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();document.querySelector("textarea").value=""})</script></body></html>'}));
      await page.goto(entry.url);
      await page.addScriptTag({path:join(root,'dom.js')});
      const result=await page.evaluate(async()=>{
        const d=window.AttnWallBridgeDOM;
        const current=d.identify(location.href);
        const messages=d.extract(document,current);
        const sent=await d.send(document,current,'Web bridge reply');
        const after=d.composer(document).value;
        d.composer(document).value='Already typed';
        let blocked=false;
        try{await d.send(document,current,'Do not overwrite');}catch{blocked=true;}
        return {current,messages,sent,after,blocked,other:d.identify('https://chatgpt.com/c/123abc')};
      });
      assert.equal(result.messages.length,2,entry.url);
      assert.deepEqual(result.messages.map(m=>m.role),['user','agent']);
      assert.ok(result.sent.sent);
      assert.equal(result.after,'');
      assert.ok(result.blocked,'Does not overwrite drafts');
      assert.equal(result.other,null);
      assert.match(result.current.runtime,/-web$/);
      if(result.current.runtime==='chatgpt-web'){
        assert.ok(result.messages.every(x=>!x.body.includes('Copy')),'Exclude auxiliary UI controls');
        assert.equal(result.current.nativeId,'6aae2ee6-a578-83ea-af71-b33479edd9ea');
      }
      await page.close();
    }
  }finally{await browser.close();}
});

test('Actual Chrome DOM: sidebar discovery and final-response-only notifications',{skip:!existsSync(chrome),timeout:45000},async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-gpu']});
  try{
    const page=await browser.newPage();
    const taskUrl='https://chatgpt.com/c/6aae2ee6-a578-83ea-af71-b33479edd9ea';
    await page.route('**/*',r=>r.fulfill({status:200,contentType:'text/html',body:
      '<!doctype html><html><body><aside><a href="/c/bcdefghi09" aria-label="Earlier topic">Earlier topic</a></aside>'+
      '<main><article data-message-author-role="user"><div class="whitespace-pre-wrap">Question</div></article>'+
      '<article data-message-author-role="assistant"><div class="markdown">Earlier answer</div></article></main></body></html>'}));
    await page.goto(taskUrl);
    await page.addScriptTag({path:join(root,'dom.js')});
    const sidebar=await page.evaluate(()=>{
      const d=window.AttnWallBridgeDOM;return d.discover(document,d.identify(location.href));
    });
    assert.equal(sidebar.length,1);
    assert.equal(sidebar[0].title,'Earlier topic');
    assert.equal(sidebar[0].nativeId,'bcdefghi09');
    await page.evaluate(()=>{
      window.__attnwallPackets=[];
      window.chrome={runtime:{
        sendMessage:async packet=>{window.__attnwallPackets.push(packet);return {ok:true};},
        onMessage:{addListener:()=>{}}
      }};
    });
    await page.addScriptTag({path:join(root,'content.js')});
    await page.waitForFunction(()=>window.__attnwallPackets.some(x=>x.type==='ATTNWALL_SYNC'),{timeout:7500});
    const baseline=await page.evaluate(()=>window.__attnwallPackets.find(x=>x.type==='ATTNWALL_SYNC'));
    assert.ok(baseline.messages.every(x=>x.silent),'Previously visible history is silent');
    assert.equal(baseline.sidebar.length,1,'Discovery reaches the background gateway');
    await page.evaluate(()=>{
      const article=document.createElement('article');
      article.setAttribute('data-message-author-role','assistant');
      article.innerHTML='<div class="markdown">Partial answer</div>';
      article.id='stream';document.querySelector('main').append(article);
      const stop=document.createElement('button');
      stop.setAttribute('data-testid','stop-button');stop.textContent='Stop';
      document.querySelector('main').append(stop);
    });
    await page.waitForTimeout(3000);
    const whileStreaming=await page.evaluate(()=>window.__attnwallPackets.filter(
      p=>p.type==='ATTNWALL_SYNC'&&(p.messages||[]).some(m=>m.body.includes('Partial answer'))).length);
    assert.equal(whileStreaming,0,'Streaming fragments must never be notified');
    await page.evaluate(()=>{
      document.querySelector('#stream .markdown').textContent='Complete response from AI';
      document.querySelector('[data-testid="stop-button"]').remove();
    });
    await page.waitForFunction(()=>window.__attnwallPackets.some(p=>
      p.type==='ATTNWALL_SYNC'&&(p.messages||[]).some(m=>m.body==='Complete response from AI'&&!m.silent)
    ),{timeout:14000});
    const completed=await page.evaluate(()=>window.__attnwallPackets.filter(p=>p.type==='ATTNWALL_SYNC')
      .flatMap(p=>p.messages||[]).filter(m=>m.body.includes('response from AI')));
    assert.equal(completed.length,1);
    assert.equal(completed[0].silent,false);
  }finally{await browser.close();}
});
test('ChatGPT SPA must not import previous route messages or sidebar search results',{skip:!existsSync(chrome),timeout:45000},async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-gpu']});
  try{
    const page=await browser.newPage();
    const a='https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const b='https://chatgpt.com/c/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    await page.route('**/*',r=>r.fulfill({status:200,contentType:'text/html',body:'<!doctype html><head><title>Chat A</title></head><body>'+
      '<nav><div data-chatgpt-search-unit-key="other:user" data-role="user">Another chat search result</div></nav>'+
      '<main><article data-message-author-role="user">Question A</article>'+
      '<article data-message-author-role="assistant"><div class="markdown">Answer A</div></article>'+
      '<section data-chatgpt-search-unit-key="other:user"><div data-role="user">Search result B</div></section></main></body>'}));
    await page.goto(a);
    await page.evaluate(()=>{window.packets=[];window.chrome={runtime:{sendMessage:async m=>{window.packets.push(m);return {ok:true};},onMessage:{addListener:()=>{}}}};});
    await page.addScriptTag({path:join(root,'dom.js')});
    await page.addScriptTag({path:join(root,'content.js')});
    await page.waitForFunction(()=>window.packets.some(p=>p.type==='ATTNWALL_SYNC'&&p.messages.length),{timeout:12000});
    const initial=await page.evaluate(()=>window.packets.find(p=>p.type==='ATTNWALL_SYNC'&&p.messages.length));
    assert.deepEqual(initial.messages.map(m=>m.body),['Question A','Answer A']);
    await page.evaluate(u=>history.pushState({},'',u),b);
    await page.waitForTimeout(4600);
    assert.equal(await page.evaluate(()=>window.packets.filter(p=>p.type==='ATTNWALL_SYNC'&&p.session.nativeId.startsWith('bbbb')).length),0);
    await page.evaluate(()=>{document.title='Chat B';document.querySelector('main').innerHTML=
      '<article data-message-author-role="user">Question B</article>'+
      '<article data-message-author-role="assistant"><div class="markdown">Answer B</div></article>';});
    await page.waitForFunction(()=>window.packets.some(p=>p.type==='ATTNWALL_SYNC'&&p.session.nativeId.startsWith('bbbb')&&p.messages.length),{timeout:14000});
    const imported=await page.evaluate(()=>window.packets.find(p=>p.type==='ATTNWALL_SYNC'&&p.session.nativeId.startsWith('bbbb')&&p.messages.length));
    assert.deepEqual(imported.messages.map(m=>m.body),['Question B','Answer B']);
    assert.ok(imported.messages.every(m=>m.silent));
    await page.evaluate(()=>{const art=document.createElement('article');art.setAttribute('data-message-author-role','assistant');art.innerHTML='<div class="markdown">New B answer</div>';document.querySelector('main').append(art);});
    await page.waitForFunction(()=>window.packets.some(p=>p.type==='ATTNWALL_SYNC'&&p.session.nativeId.startsWith('bbbb')&&p.messages.some(m=>m.body==='New B answer'&&!m.silent)),{timeout:14000});
  }finally{await browser.close();}
});
test('Background routes replies by exact saved URL, not by current active tab',async()=>{
  const vm=await import('node:vm');
  const script=readFileSync(join(root,'background.js'),'utf8');
  const opened=[],delivered=[],registered={},local=new Map();
  const chromeMock={
    runtime:{onMessage:{addListener:()=>{}},onInstalled:{addListener:()=>{}},onStartup:{addListener:()=>{}}},
    alarms:{create:()=>{},onAlarm:{addListener:()=>{}}},
    tabs:{
      query:async()=>[...local.values()],
      create:async({url,active})=>{opened.push({url,active});const tab={id:37,url};local.set(tab.id,tab);return tab;},
      update:async(id,{url})=>{const tab=local.get(id);tab.url=url;return tab;},
      sendMessage:async(id,payload)=>{
        if(payload.type==='ATTNWALL_PROBE')return {ok:true,ready:true};
        delivered.push({id,payload});return {ok:true,sent:true};
      },
      onRemoved:{addListener:()=>{}},onUpdated:{addListener:()=>{}}
    },
    storage:{local:{get:async()=>({deviceId:'some-device',enabled:false}),set:async()=>{}}}
  };
  const ctx=vm.createContext({chrome:chromeMock,URL,Map,Set,Promise,Date,crypto:globalThis.crypto||await import('node:crypto').then(x=>x.webcrypto),
    console,setTimeout,clearTimeout,AbortSignal});
  vm.runInContext(script,ctx);
  const url='https://chatgpt.com/c/bcdefghi09';
  const target=await vm.runInContext('targetTab({runtime:"chatgpt-web",native_id:"bcdefghi09",source_url:"'+url+'"})',ctx);
  assert.equal(target.opened,true);
  assert.deepEqual(opened,[{url:'about:blank',active:false}]);
  assert.equal(local.get(37).url,url);
  const existing=await vm.runInContext('targetTab({runtime:"chatgpt-web",native_id:"bcdefghi09",source_url:"'+url+'"})',ctx);
  assert.equal(existing.opened,false);
  assert.equal(opened.length,1,'No duplicate tab creation');
  await vm.runInContext('dispatch({id:37},{runtime:"chatgpt-web",native_id:"bcdefghi09",text:"Reply"})',ctx);
  assert.equal(delivered[0].payload.nativeId,'bcdefghi09');
  local.clear();
  await assert.rejects(vm.runInContext('targetTab({runtime:"chatgpt-web",native_id:"wrong-target",source_url:"'+url+'"})',ctx),/尚未被扩展发现/);
  await assert.rejects(vm.runInContext('targetTab({runtime:"chatgpt-web",native_id:"bcdefghi09",source_url:"https:\/\/other.example\/c\/bcdefghi09"})',ctx),/尚未被扩展发现/);
});
test('ChatGPT web composer: delayed icon-only Send replaces voice action after typing',{skip:!existsSync(chrome)},async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-gpu']});
  try{
    const page=await browser.newPage();
    const html=[
      '<!doctype html><main><form id="chat-form">',
      '<textarea id="prompt-textarea" style="width:320px;height:60px"></textarea>',
      '<button type="button" aria-label="Start dictation" id="voice">Voice</button>',
      '<div id="buttons"></div></form></main>',
      '<script>',
      'window.sent=[];window.clickedVoice=0;',
      'document.querySelector("#voice").addEventListener("click",()=>window.clickedVoice++);',
      'const editor=document.querySelector("#prompt-textarea");',
      'editor.addEventListener("input",()=>setTimeout(()=>{',
      'if(editor.value && !document.querySelector("#composer-submit-button")){',
      'const button=document.createElement("button");',
      'button.id="composer-submit-button";button.type="button";',
      'button.setAttribute("aria-label","Отправить промпт");',
      'button.innerHTML="<svg viewBox=\\"0 0 20 20\\"><path d=\\"M10 2 L10 18\\"/></svg>";',
      'button.addEventListener("click",()=>{window.sent.push(editor.value);editor.value="";});',
      'document.querySelector("#buttons").append(button);',
      '}},90));',
      '</script>'
    ].join('');
    await page.route('**/*',r=>r.fulfill({status:200,contentType:'text/html',body:html}));
    await page.goto('https://chatgpt.com/g/g-p-6aae2e8158188191a1940861904284d2-project/c/6aae2ee6-a578-83ea-af71-b33479edd9ea');
    await page.addScriptTag({path:join(root,'dom.js')});
    const result=await page.evaluate(async()=>{
      const api=window.AttnWallBridgeDOM;
      const sent=await api.send(document,api.identify(location.href),'Review the training progress.');
      return {sent,actual:window.sent,voice:window.clickedVoice,editor:document.querySelector('#prompt-textarea').value};
    });
    assert.equal(result.sent.sent,true);
    assert.deepEqual(result.actual,['Review the training progress.']);
    assert.equal(result.voice,0,'Must not click dictation instead of Send');
    assert.equal(result.editor,'');
    await page.close();
  }finally{await browser.close();}
});
test('ChatGPT contenteditable supports exact send-test-id and refuses ambiguous or existing drafts',{skip:!existsSync(chrome)},async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-gpu']});
  try{
    const page=await browser.newPage();
    const html=[
      '<!doctype html><main><form id="chat-form">',
      '<div id="prompt-textarea" class="ProseMirror" data-lexical-editor="true" contenteditable="true" role="textbox" style="width:330px;height:60px;border:1px solid"></div>',
      '<button type="button" data-testid="send-button" aria-label="发送提示" id="send">↑</button>',
      '</form><form id="other"><button type="submit" id="danger">OTHER</button></form></main>',
      '<script>window.sent=[];window.danger=0;',
      'document.querySelector("#danger").onclick=e=>{e.preventDefault();window.danger++};',
      'document.querySelector("#send").onclick=e=>{e.preventDefault();window.sent.push(document.querySelector("#prompt-textarea").innerText);document.querySelector("#prompt-textarea").textContent="";};',
      '</script>'
    ].join('');
    await page.route('**/*',r=>r.fulfill({status:200,contentType:'text/html',body:html}));
    await page.goto('https://chatgpt.com/c/6aae2ee6-a578-83ea-af71-b33479edd9ea');
    await page.addScriptTag({path:join(root,'dom.js')});
    const result=await page.evaluate(async()=>{
      const api=window.AttnWallBridgeDOM,provider=api.identify(location.href);
      const sent=await api.send(document,provider,'Safe ChatGPT reply');
      const editor=api.composer(document);
      editor.textContent='Existing unsent draft';
      let draftError='';
      try{await api.send(document,provider,'Do not replace this');}catch(e){draftError=e.message;}
      const extra=document.createElement('button');
      extra.type='button';extra.setAttribute('data-testid','send-button');
      extra.id='second-send';extra.textContent='another send';
      document.querySelector('#chat-form').append(extra);
      editor.textContent='';
      let ambiguousError='';
      try{await api.send(document,provider,'Do not send when ambiguous');}catch(e){ambiguousError=e.message;}
      return {sent,actual:window.sent,danger:window.danger,draftError,ambiguousError,
        stillDraft:editor.innerText};
    });
    assert.equal(result.sent.sent,true);
    assert.deepEqual(result.actual,['Safe ChatGPT reply']);
    assert.equal(result.danger,0,'Must not click a button in another form');
    assert.match(result.draftError,/已有其他草稿/);
    assert.match(result.ambiguousError,/Multiple possible Send buttons/);
    assert.deepEqual(result.actual,['Safe ChatGPT reply']);
    assert.match(result.stillDraft,/Do not send when ambiguous/);
    await page.close();
  }finally{await browser.close();}
});
