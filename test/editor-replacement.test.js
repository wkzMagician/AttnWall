import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright-core';
const chrome=process.env.ATTNWALL_CHROME||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome');
test('Web editor replacement: restore unsent draft, send once, never overwrite other drafts', {skip:!existsSync(chrome)},async()=>{
 const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage();
  const html=[
   '<!doctype html><html><body><main><form><textarea id="prompt-textarea" style="width:300px;height:90px"></textarea>',
   '<button aria-label="Send prompt" type="submit" disabled>Send</button></form></main><script>',
   'window.calls=0;window.replacements=0;',
   'const form=document.querySelector("form"),button=form.querySelector("button");',
   'function attach(editor){editor.addEventListener("input",()=>{',
   'if(window.replacements<2){window.replacements++;',
   'const fresh=document.createElement("textarea");fresh.id="prompt-textarea";fresh.style.cssText="width:300px;height:90px";attach(fresh);',
   'setTimeout(()=>{if(editor.isConnected)editor.replaceWith(fresh);button.disabled=true;},20);',
   '}else{setTimeout(()=>button.disabled=false,30);}',
   '});}',
   'attach(form.querySelector("textarea"));',
   'form.addEventListener("submit",e=>{e.preventDefault();window.calls++;window.submitted=form.querySelector("textarea").value;form.querySelector("textarea").value="";button.disabled=true;});',
   '</script></body></html>'
  ].join('');
  await page.route('**/*',r=>r.fulfill({status:200,contentType:'text/html',body:html}));
  await page.goto('https://chatgpt.com/c/6aae2ee6-a578-83ea-af71-b33479edd9ea');
  await page.addScriptTag({path:'extensions/browser/dom.js'});
  const submitted=await page.evaluate(async()=>{
    const d=window.AttnWallBridgeDOM;
    return await d.send(document,d.identify(location.href),'Unique output token');
  });
  assert.equal(submitted.sent,true);
  assert.deepEqual(await page.evaluate(()=>({calls:window.calls,submitted:window.submitted,replacements:window.replacements})),
    {calls:1,submitted:'Unique output token',replacements:2});
  await page.evaluate(()=>{document.querySelector('textarea').value='Human draft';});
  const failure=await page.evaluate(async()=>{
    const d=window.AttnWallBridgeDOM;
    try{await d.send(document,d.identify(location.href),'New unrelated reply');return 'unexpected success';}
    catch(e){return e.message;}
  });
  assert.match(failure,/其他草稿/);
  assert.equal(await page.evaluate(()=>window.calls),1);
  assert.equal(await page.locator('textarea').inputValue(),'Human draft');
 }finally{await browser.close();}
});
