import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {chromium} from 'playwright-core';

const chrome=process.env.ATTNWALL_CHROME||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome');
const url='https://chatgpt.com/c/attnwall-regression-a';
async function withPage(html,run){
  const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-gpu']});
  try{
    const page=await browser.newPage();
    await page.route('https://chatgpt.com/**',r=>r.fulfill({contentType:'text/html',body:html}));
    await page.goto(url);
    await page.addScriptTag({path:'extensions/browser/dom.js'});
    await page.addScriptTag({path:'extensions/browser/i18n.js'});
    await run(page);
  }finally{await browser.close();}
}
const options={skip:!existsSync(chrome)};

test('ChatGPT collector loads at the homepage before SPA conversation creation',()=>{
  const manifest=JSON.parse(readFileSync('extensions/browser/manifest.json','utf8'));
  assert.ok(manifest.content_scripts.some(s=>s.matches.includes('https://chatgpt.com/*')),
    'A content script limited to /c/* never runs after new-chat navigation from /');
});

test('History capture waits for the new route DOM, including replies with identical text',options,async()=>{
  await withPage('<main><article data-message-author-role="user">Shared greeting</article><article data-message-author-role="assistant">Old answer</article><textarea></textarea></main>',async page=>{
    await page.evaluate(()=>{
      window.packs=[];
      window.chrome={runtime:{sendMessage:async p=>{window.packs.push(p);return {ok:true};},onMessage:{addListener:fn=>window.receive=fn}}};
    });
    await page.addScriptTag({path:'extensions/browser/content.js'});
    await page.waitForFunction(()=>window.packs.some(p=>p.type==='ATTNWALL_SYNC'));
    const during=await page.evaluate(()=>{
      history.pushState({},'','/c/attnwall-regression-b');
      let response;
      window.receive({type:'ATTNWALL_CAPTURE',runtime:'chatgpt-web',nativeId:'attnwall-regression-b'},null,r=>response=r);
      return response;
    });
    assert.equal(during.ok,false,'History requests cannot bypass the SPA route guard');
    assert.equal(during.messages?.length||0,0,'No A messages may be imported under B');
    const guarded=await page.evaluate(async()=>{
      let probe;
      window.receive({type:'ATTNWALL_PROBE',runtime:'chatgpt-web',nativeId:'attnwall-regression-b'},null,r=>probe=r);
      const delivery=await new Promise(resolve=>window.receive({type:'ATTNWALL_DELIVER',runtime:'chatgpt-web',nativeId:'attnwall-regression-b',text:'Must not enter A'},null,resolve));
      return {probe,delivery,draft:document.querySelector('textarea').value};
    });
    assert.equal(guarded.probe.ready,false);
    assert.equal(guarded.delivery.ok,false);
    assert.equal(guarded.draft,'');
    await page.evaluate(()=>{
      document.querySelector('main').innerHTML='<article data-message-author-role="user">Shared greeting</article><article data-message-author-role="assistant">New answer</article><textarea></textarea>';
    });
    await page.waitForFunction(()=>window.packs.some(p=>p.type==='ATTNWALL_SYNC'&&p.session.nativeId==='attnwall-regression-b'));
    const after=await page.evaluate(()=>{
      let response;
      window.receive({type:'ATTNWALL_CAPTURE',runtime:'chatgpt-web',nativeId:'attnwall-regression-b'},null,r=>response=r);
      return response;
    });
    assert.equal(after.ok,true,'Replaced DOM must unblock even when two conversations share text');
    assert.deepEqual(after.messages.map(m=>m.body),['Shared greeting','New answer']);
  });
});

test('Requested web history reads only five recent messages',options,async()=>{
  const messages=Array.from({length:140},(_,i)=>'<article data-message-id="m'+i+'" data-message-author-role="'+(i%2?'assistant':'user')+'">History '+i+'</article>').join('');
  await withPage('<main>'+messages+'</main>',async page=>{
    await page.evaluate(()=>{window.chrome={runtime:{sendMessage:async()=>({ok:true}),onMessage:{addListener:fn=>window.receive=fn}}};});
    await page.addScriptTag({path:'extensions/browser/content.js'});
    const result=await page.evaluate(()=>{
      let response;
      window.receive({type:'ATTNWALL_CAPTURE',runtime:'chatgpt-web',nativeId:'attnwall-regression-a'},null,r=>response=r);
      return response;
    });
    assert.equal(result.messages.length,5);
    assert.equal(result.messages[0].body,'History 135');
  });
});

test('Web send confirms a new user turn even while the old editor draft is retained',options,async()=>{
  await withPage('<main><form><textarea id="prompt-textarea"></textarea><button type="button" data-testid="send-button">Send</button></form></main>',async page=>{
    await page.evaluate(()=>{
      document.querySelector('button').onclick=()=>{
        const turn=document.createElement('article');turn.dataset.messageAuthorRole='user';turn.textContent=document.querySelector('textarea').value;
        document.querySelector('main').prepend(turn);
      };
    });
    const result=await page.evaluate(()=>AttnWallBridgeDOM.send(document,AttnWallBridgeDOM.identify(location.href),'Receipt test'));
    assert.equal(result.sent,true);
    assert.equal(await page.locator('article').count(),1);
  });
});

test('A cleared replacement editor without a user turn is an uncertain send',options,async()=>{
  await withPage('<main><article data-message-author-role="user">Receipt test</article><form><textarea id="prompt-textarea"></textarea><button type="button" data-testid="send-button">Send</button></form></main>',async page=>{
    await page.evaluate(()=>{document.querySelector('button').onclick=()=>{document.querySelector('textarea').outerHTML='<textarea id="prompt-textarea"></textarea>';};});
    const error=await page.evaluate(async()=>{
      try{await AttnWallBridgeDOM.send(document,AttnWallBridgeDOM.identify(location.href),'Receipt test');return '';}
      catch(e){return e.message;}
    });
    assert.match(error,/不确定/,'An existing identical turn and a reset composer do not prove a new submission');
  });
});

test('Sending to a generating conversation leaves its editor untouched',options,async()=>{
  await withPage('<main><form><textarea id="prompt-textarea"></textarea><button data-testid="stop-button">Stop</button></form></main>',async page=>{
    const result=await page.evaluate(async()=>{
      try{await AttnWallBridgeDOM.send(document,AttnWallBridgeDOM.identify(location.href),'Must not become a draft');}
      catch(e){return {error:e.message,value:document.querySelector('textarea').value};}
    });
    assert.match(result.error,/正在生成/);
    assert.equal(result.value,'');
  });
});

test('Initial bounded history stays silent',options,async()=>{
  const messages=Array.from({length:90},(_,i)=>'<article data-message-id="m'+i+'" data-message-author-role="'+(i%2?'assistant':'user')+'">Initial '+i+'</article>').join('');
  await withPage('<main>'+messages+'</main>',async page=>{
    await page.evaluate(()=>{window.packs=[];window.chrome={runtime:{sendMessage:async p=>{window.packs.push(p);return {ok:true};},onMessage:{addListener:()=>{}}}};});
    await page.addScriptTag({path:'extensions/browser/content.js'});
    await page.waitForFunction(()=>window.packs.filter(p=>p.type==='ATTNWALL_SYNC').flatMap(p=>p.messages).length>=5);
    const imported=await page.evaluate(()=>window.packs.filter(p=>p.type==='ATTNWALL_SYNC').flatMap(p=>p.messages));
    assert.equal(imported.length,5);
    assert.ok(imported.every(m=>m.silent));
  });
});

test('Reading a large DOM checks geometry and text only for the five selected messages',options,async()=>{
  const messages=Array.from({length:2000},(_,i)=>'<article data-message-author-role="'+(i%2?'assistant':'user')+'">Large history '+i+'</article>').join('');
  await withPage('<main>'+messages+'</main>',async page=>{
    const result=await page.evaluate(()=>{
      let textReads=0,rectReads=0;
      const text=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'innerText');
      Object.defineProperty(HTMLElement.prototype,'innerText',{configurable:true,get(){if(this.matches('[data-message-author-role]'))textReads++;return text.get.call(this);}});
      const rect=Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect=function(){if(this.matches('[data-message-author-role]'))rectReads++;return rect.call(this);};
      const messages=AttnWallBridgeDOM.extract(document,AttnWallBridgeDOM.identify(location.href),{limit:Infinity});
      return {messages,textReads,rectReads};
    });
    assert.equal(result.messages.length,5);
    assert.equal(result.messages[0].body,'Large history 1995');
    assert.ok(result.textReads<=5,'The cap must apply before reading any old message text');
    assert.ok(result.rectReads<=5,'The cap must apply before layout/visibility checks');
  });
});
