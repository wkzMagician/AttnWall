import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright-core';

const chrome=process.env.ATTNWALL_CHROME||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome');
test('Same multiline draft submits once across textarea and rich text representations', {skip:!existsSync(chrome)},async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox']});
  try{
    for(const [rich,prefilled,blank] of [[false,true,false],[true,true,false],[true,false,false],[true,true,true]]){
      const text='First line'+(blank?'\r\n\r\n':'\r\n')+'Second line';
      const page=await browser.newPage();
      await page.route('https://chatgpt.com/**',r=>r.fulfill({contentType:'text/html',body:
        '<main><form>'+(rich?'<div id="prompt-textarea" contenteditable="true">'+(prefilled?'<p>First line</p>'+(blank?'<p><br></p>':'')+'<p>Second line</p>':'')+'</div>':'<textarea id="prompt-textarea">First line\nSecond line</textarea>')+
        '<button type="submit" aria-label="Send prompt">Send</button></form></main>'}));
      await page.goto('https://chatgpt.com/c/draft-normalization');
      await page.addScriptTag({path:'extensions/browser/dom.js'});
      await page.evaluate(()=>{
        window.calls=0;
        document.querySelector('form').addEventListener('submit',e=>{
          e.preventDefault();window.calls++;
          const editor=document.getElementById('prompt-textarea');
          if(editor.isContentEditable)editor.replaceChildren();else editor.value='';
        });
      });
      const result=await page.evaluate(async text=>{
        const dom=window.AttnWallBridgeDOM;
        try{return await dom.send(document,dom.identify(location.href),text);}
        catch(e){return {error:e.message};}
      },text);
      assert.equal(result.sent,true,JSON.stringify({rich,...result}));
      assert.equal(await page.evaluate(()=>window.calls),1);
      await page.close();
    }
  }finally{await browser.close();}
});
