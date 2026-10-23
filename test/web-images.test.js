import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core.js';
import {chromium} from 'playwright-core';
const png=Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3]).toString('base64');

test('Image reply is validated, host-bound, and attachment bytes are deleted after sending',()=>{
 const dir=mkdtempSync(join(tmpdir(),'aw-image-')),s=new Store(join(dir,'test.db'));
 try{
  const id=s.session({host:'web-123456789abc',runtime:'chatgpt-web',nativeId:'somewebchat'});
  assert.throws(()=>s.queueImageReply(id,'',{type:'image/jpeg',data:png}),/signature/);
  const r=s.queueImageReply(id,'',{type:'image/png',name:'test.png',data:png},'image-job');
  assert.ok(r.attachment_id);
  const job=s.claimReplies('web-123456789abc')[0];
  assert.equal(s.replyImage(job.id,'web-123456789abc').data,png);
  assert.throws(()=>s.replyImage(job.id,'web-other123'),/unavailable/);
  s.replyState(job.id,'failed','Not ready');
  assert.equal(s.db.prepare('SELECT count(*) n FROM attachments').get().n,1);
  s.replyState(job.id,'queued');s.claimReplies('web-123456789abc');
  s.replyState(job.id,'sent');
  assert.equal(s.db.prepare('SELECT count(*) n FROM attachments').get().n,0);
  assert.equal(s.messages(id).at(-1).body,'[图片]');
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('Web history jobs require the correct extension host',()=>{
 const dir=mkdtempSync(join(tmpdir(),'aw-history-')),s=new Store(join(dir,'test.db'));
 try{
  const id=s.session({host:'web-a12345678',runtime:'chatgpt-web',nativeId:'aa12345678',sourceUrl:'https://chatgpt.com/c/aa12345678'});
  s.requestHistory(id);
  assert.equal(s.claimWebHistory('web-other123').length,0);
  const [job]=s.claimWebHistory('web-a12345678');
  assert.equal(job.source_url,'https://chatgpt.com/c/aa12345678');
  s.completeHistory(id);
  assert.equal(s.historyStatus(id).state,'complete');
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
const chrome=process.env.ATTNWALL_CHROME||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome');
test('ChatGPT synthetic DOM: read two messages and attach image before sending',{skip:!existsSync(chrome)},async()=>{
 const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage();
  const html='<!doctype html><html><body><main><article data-testid="conversation-turn"><div data-message-author-role="user">Question</div></article><article data-testid="conversation-turn"><div data-message-author-role="assistant"><div class="markdown">Answer</div></div></article><form><textarea id="prompt-textarea" style="width:230px;height:40px"></textarea><input type="file" accept="image/*"><button type="submit" aria-label="Send prompt">Send</button></form></main><script>window.sent=[];document.querySelector("input[type=file]").addEventListener("change",e=>{let x=document.createElement("div");x.dataset.testid="attachment-preview";x.innerText=e.target.files[0]?.name||"";document.querySelector("form").append(x)});document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.sent.push({text:document.querySelector("textarea").value,filename:document.querySelector("input[type=file]").files[0]?.name});document.querySelector("textarea").value="";document.querySelector("[data-testid=attachment-preview]")?.remove()})</script></body></html>';
  await page.route('**/*',r=>r.fulfill({status:200,contentType:'text/html',body:html}));
  await page.goto('https://chatgpt.com/c/6aae2ee6-a578-83ea-af71-b33479edd9ea');
  await page.addScriptTag({path:'extensions/browser/dom.js'});
  const result=await page.evaluate(async data=>{
   const d=window.AttnWallBridgeDOM,info=d.identify(location.href);
   const history=d.extract(document,info);
   const submitted=await d.send(document,info,'Analyze picture',{image:{type:'image/png',data,name:'question.png'}});
   return {history,submitted,sent:window.sent};
  },png);
  assert.deepEqual(result.history.map(x=>x.role),['user','agent']);
  assert.equal(result.submitted.sent,true);
  assert.equal(result.sent[0].filename,'question.png');
  assert.equal(result.sent[0].text,'Analyze picture');
 }finally{await browser.close();}
});
