import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright-core';

const chrome=process.env.ATTNWALL_CHROME||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome');
for(const initiallyRunning of [false,true])test('Web notification captures a short reply '+(initiallyRunning?'already running on load':'between polls'),{skip:!existsSync(chrome),timeout:25000},async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox']});
  try{
    const page=await browser.newPage();
    const html='<main><article data-message-author-role="user">Question</article><article data-message-author-role="assistant"><div class="markdown">Initial answer</div></article>'+(initiallyRunning?'<button data-testid="stop-button" id="running">Stop</button>':'')+'</main>';
    await page.route('https://chatgpt.com/**',r=>r.fulfill({contentType:'text/html',body:html}));
    await page.goto('https://chatgpt.com/c/6aae2ee6-a578-83ea-af71-b33479edd9ea');
    await page.addScriptTag({path:'extensions/browser/dom.js'});
    await page.evaluate(()=>{
      window.packets=[];
      window.chrome={runtime:{sendMessage:async packet=>{window.packets.push(packet);return {ok:true};},onMessage:{addListener:()=>{}}}};
    });
    await page.addScriptTag({path:'extensions/browser/content.js'});
    if(!initiallyRunning){
      await page.waitForFunction(()=>window.packets.some(p=>p.type==='ATTNWALL_SYNC'));
      await page.evaluate(()=>{
        document.querySelector('main').insertAdjacentHTML('beforeend','<article data-message-author-role="user">New question</article><article data-message-author-role="assistant"><div class="markdown">Partial</div></article><button data-testid="stop-button" id="running">Stop</button>');
      });
    }
    // Shorter than the 900ms startup delay and 3500ms poll interval.
    await page.waitForTimeout(100);
    await page.evaluate(()=>{
      document.getElementById('running').remove();
      document.querySelector('main article:last-of-type .markdown').textContent='Short completed reply';
    });
    await page.waitForFunction(()=>window.packets.some(p=>p.type==='ATTNWALL_SYNC'&&p.completions?.length),{timeout:12000});
    const packets=await page.evaluate(()=>window.packets.filter(p=>p.type==='ATTNWALL_SYNC'));
    assert.equal(packets.flatMap(p=>p.completions||[]).length,1);
    const reply=packets.flatMap(p=>p.messages||[]).find(m=>m.body==='Short completed reply');
    assert.ok(reply);assert.equal(reply.silent,false,'A live completion is never silently imported as history');
    if(!initiallyRunning)assert.ok(packets[0].messages.every(m=>m.silent),'Idle historical replies remain silent');
  }finally{await browser.close();}
});
