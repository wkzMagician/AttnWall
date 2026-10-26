import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core.js';
import {CodexAdapter,DshAdapter} from '../src/adapters.js';
import {chromium} from 'playwright-core';

function fixture(fn){
 const dir=mkdtempSync(join(tmpdir(),'attnwall-completion-'));const store=new Store(join(dir,'test.db'));
 try{return fn(store);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
}
test('Codex and DSH emit exactly one completion per run, not per message',()=>{
 const codexMessages=[],codexComplete=[],codexStarts=[];
 const codex=new CodexAdapter(m=>codexMessages.push(m),()=>{},c=>codexComplete.push(c),r=>codexStarts.push(r));
 codex.rpc.emit('notification','turn/started',{threadId:'thread1',turn:{id:'turn-1'}});
 assert.equal(codexStarts.length,1);
 assert.equal(codexStarts[0].runId,'turn-1');
 assert.ok(Math.abs(codexStarts[0].at-Date.now())<1000);
 codex.rpc.emit('notification','item/completed',{threadId:'thread1',turnId:'turn-1',item:{type:'agentMessage',id:'a1',text:'First progress'}});
 codex.rpc.emit('notification','item/completed',{threadId:'thread1',turnId:'turn-1',item:{type:'agentMessage',id:'a2',text:'Final result'}});
 assert.equal(codexComplete.length,0);
 assert.equal(codexMessages.length,2);
 assert.ok(codexMessages.every(m=>m.runId==='turn-1'));
 codex.rpc.emit('notification','turn/completed',{threadId:'thread1',turn:{id:'turn-1',status:'completed'}});
 assert.equal(codexComplete.length,1);
 assert.equal(codexComplete[0].runId,'turn-1');
 const dshMessages=[],dshComplete=[],dshStarts=[];
 const dsh=new DshAdapter(m=>dshMessages.push(m),()=>{},c=>dshComplete.push(c),r=>dshStarts.push(r));
 dsh.rpc.emit('notification','session.event',{sessionId:'sdk-session',event:{type:'turn/start',seq:20}});
 assert.equal(dshStarts.length,1);
 assert.equal(dshStarts[0].runId,'dsh:20');
 dsh.rpc.emit('notification','session.event',{sessionId:'sdk-session',event:{type:'assistant/message',seq:21,data:{message:{content:[{type:'text',text:'Progress one'}]}}}});
 dsh.rpc.emit('notification','session.event',{sessionId:'sdk-session',event:{type:'assistant/message',seq:22,data:{message:{content:[{type:'text',text:'Progress two'}]}}}});
 assert.equal(dshComplete.length,0);
 assert.equal(dshMessages[0].runId,dshMessages[1].runId);
 dsh.rpc.emit('notification','session.event',{sessionId:'sdk-session',event:{type:'turn/end',seq:23,data:{reason:{kind:'completed'}}}});
 assert.equal(dshComplete.length,1);
 assert.equal(dshComplete[0].runId,dshMessages[0].runId);
 codex.close();dsh.close();
});
test('Unfinished messages invisible; one queued completion per run, idempotent, Instant at completion',()=>fixture(store=>{
 const sid=store.session({runtime:'codex',nativeId:'completed-run',title:'Test'});
 store.message({sessionId:sid,externalId:'p1',runId:'t-1',body:'Step 1'});
 store.message({sessionId:sid,externalId:'p2',runId:'t-1',body:'Step 2'});
 store.message({sessionId:sid,externalId:'p3',runId:'t-1',body:'Step 3'});
 assert.equal(store.pendingNotifications().length,0);
 assert.equal(store.readyInbox().length,0);
 const final=store.completeRun(sid,'t-1');
 assert.equal(final.body,'Step 3');
 assert.equal(store.pendingNotifications().length,1);
 assert.equal(store.completeRun(sid,'t-1'),null);
 assert.equal(store.pendingNotifications().length,1);
 store.claimNotificationBatch(Date.now());
 assert.equal(store.readyInbox().length,1,'Only the final output counts as an inbox message');
 assert.equal(store.readyInbox()[0].body,'Step 3');
 assert.equal(store.readyUnreadCount(),1);
 assert.equal(store.readyUnreadCount(sid),1);
 assert.equal(store.readySessions()[0].unread,1);
 assert.equal(store.messages(sid).length,3,'Progress remains available in conversation history');
 store.instantMode(sid,true);
 store.message({sessionId:sid,runId:'t-2',body:'Still working',priority:'instant'});
 assert.equal(store.readyInbox().length,1);
 const instant=store.completeRun(sid,'t-2');
 assert.equal(instant.body,'Still working');
 assert.equal(store.pendingNotifications().length,0);
 assert.equal(store.readyInbox().length,2,'Instant releases only after completion');
}));
const chrome=process.env.ATTNWALL_CHROME||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome');
test('Web completion needs witnessed running -> finished; idle progress never notifies',{skip:!existsSync(chrome),timeout:30000},async()=>{
 const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage();
  const html='<!doctype html><html><body><main>'+
    '<article data-message-author-role="user">A user question</article>'+
    '<article data-message-author-role="assistant"><div class="markdown">Baseline answer</div></article>'+
    '</main></body></html>';
  await page.route('**/*',r=>r.fulfill({status:200,contentType:'text/html',body:html}));
  await page.goto('https://chatgpt.com/c/6aae2ee6-a578-83ea-af71-b33479edd9ea');
  await page.addScriptTag({path:'extensions/browser/dom.js'});
  await page.evaluate(()=>{
    window.__packs=[];
    window.chrome={runtime:{sendMessage:async packet=>{window.__packs.push(packet);return {ok:true};},onMessage:{addListener:()=>{}}}};
  });
  await page.addScriptTag({path:'extensions/browser/content.js'});
  await page.waitForFunction(()=>window.__packs.some(p=>p.type==='ATTNWALL_SYNC'),{timeout:7000});
  await page.evaluate(()=>{
    const main=document.querySelector('main');
    const user=document.createElement('article');user.setAttribute('data-message-author-role','user');user.textContent='New request';main.append(user);
    const agent=document.createElement('article');agent.setAttribute('data-message-author-role','assistant');agent.innerHTML='<div class="markdown">Intermediate answer</div>';main.append(agent);
  });
  await page.waitForTimeout(4000);
  const noStop=await page.evaluate(()=>window.__packs.filter(p=>p.type==='ATTNWALL_SYNC').flatMap(p=>p.completions||[]).length);
  assert.equal(noStop,0,'Idle DOM alone must not signal completion');
  await page.evaluate(()=>{
    const b=document.createElement('button');b.setAttribute('data-testid','stop-button');b.id='running';b.textContent='Stop';document.querySelector('main').append(b);
  });
  await page.waitForTimeout(4000);
  await page.evaluate(()=>{
    document.getElementById('running').remove();
    document.querySelector('main article:last-of-type .markdown').textContent='Final answer';
  });
  await page.waitForFunction(()=>window.__packs.some(p=>p.type==='ATTNWALL_SYNC'&&(p.completions||[]).length),{timeout:10000});
  const finished=await page.evaluate(()=>window.__packs.filter(p=>p.type==='ATTNWALL_SYNC').flatMap(p=>p.completions||[]));
  assert.equal(finished.length,1,'Exactly one completion after generation actually ended');
  assert.match(finished[0].runId,/^web:dom-/);
 }finally{await browser.close();}
});
