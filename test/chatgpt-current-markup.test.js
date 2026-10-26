import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright-core';

const chrome=process.env.ATTNWALL_CHROME||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome');
const options={skip:!existsSync(chrome)};
const conversation='current-conversation-1234',url='https://chatgpt.com/c/'+conversation;
function turn(index,id=conversation){
  return `<div data-content-search-turn-key="turn-${index}"><div data-talvt-turn-state="complete">
    <div data-chatgpt-search-unit-key="turn-${index}:user" data-chatgpt-search-message-ids="user-${index}"><div data-user-message-bubble="true"><div class="whitespace-pre-wrap">Question ${index}</div></div><button>Edit user</button></div>
    <div data-chatgpt-search-unit-key="turn-${index}:assistant" data-chatgpt-search-message-ids="answer-${index}"><div data-chatgpt-selection-conversation-id="${id}" data-chatgpt-selection-message-id="answer-${index}"><div data-markdown-text-style="assistant-message"><div data-dil-message-id="answer-${index}"><p>Answer ${index}</p></div></div></div><button>Copy answer</button></div>
  </div></div>`;
}
async function withPage(html,run){
  const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox']});
  try{
    const page=await browser.newPage();
    await page.route('https://chatgpt.com/**',route=>route.fulfill({contentType:'text/html',body:html}));
    await page.goto(url);await page.addScriptTag({path:'extensions/browser/dom.js'});await run(page);
  }finally{await browser.close();}
}

test('Observed ChatGPT markup captures current user and assistant bodies without toolbars',options,async()=>{
  await withPage('<main>'+turn(0)+turn(1)+'</main>',async page=>{
    const messages=await page.evaluate(()=>AttnWallBridgeDOM.extract(document,AttnWallBridgeDOM.identify(location.href)));
    assert.deepEqual(messages.map(m=>[m.role,m.body]),[['user','Question 0'],['agent','Answer 0'],['user','Question 1'],['agent','Answer 1']]);
    assert.equal(new Set(messages.map(m=>m.externalId)).size,4);
  });
});

test('Current markup still rejects search overlays, dialogs and a retained different conversation',options,async()=>{
  await withPage('<main>'+turn(0)+turn(1,'other-conversation-1234')+
    '<div data-chatgpt-search-unit-key="search"><div data-message-author-role="assistant">Legacy search hit</div><div data-markdown-text-style="assistant-message">Modern search hit</div></div>'+
    '<div role="dialog">'+turn(2)+'</div><aside>'+turn(3)+'</aside></main>',async page=>{
    const messages=await page.evaluate(()=>AttnWallBridgeDOM.extract(document,AttnWallBridgeDOM.identify(location.href)));
    assert.deepEqual(messages.map(m=>m.body),['Question 0','Answer 0']);
  });
});

test('Content-script history capture works with the observed current ChatGPT structure',options,async()=>{
  await withPage('<main>'+turn(0)+turn(1)+turn(2)+'</main>',async page=>{
    await page.evaluate(()=>{window.chrome={runtime:{sendMessage:async()=>({ok:true}),onMessage:{addListener:fn=>window.receive=fn}}};});
    await page.addScriptTag({path:'extensions/browser/content.js'});
    const result=await page.evaluate(()=>{let result;window.receive({type:'ATTNWALL_CAPTURE',runtime:'chatgpt-web',nativeId:'current-conversation-1234'},null,value=>result=value);return result;});
    assert.equal(result.ok,true);assert.equal(result.messages.length,5);
    assert.deepEqual(result.messages.slice(-2).map(m=>m.body),['Question 2','Answer 2']);
  });
});

test('Modern ChatGPT extraction stays bounded even when the DOM contains a large history',options,async()=>{
  await withPage('<main>'+Array.from({length:500},(_,index)=>turn(index)).join('')+'</main>',async page=>{
    const result=await page.evaluate(()=>{
      let reads=0;const rect=Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect=function(){reads++;return rect.call(this);};
      const messages=AttnWallBridgeDOM.extract(document,AttnWallBridgeDOM.identify(location.href));return {reads,messages};
    });
    assert.equal(result.messages.length,5);assert.ok(result.reads<=5);
    assert.equal(result.messages.at(-1).body,'Answer 499');
  });
});

test('An explicitly completed new ChatGPT turn reaches the inbox even without a stop button',{...options,timeout:25000},async()=>{
  await withPage('<main>'+turn(0)+'</main>',async page=>{
    await page.evaluate(()=>{
      window.packets=[];window.failNext=false;
      window.chrome={runtime:{sendMessage:async packet=>{
        if(packet.completions?.length&&window.failNext){window.failNext=false;return {ok:false};}
        window.packets.push(packet);return {ok:true};
      },onMessage:{addListener:()=>{}}}};
    });
    await page.addScriptTag({path:'extensions/browser/content.js'});
    await page.waitForFunction(()=>window.packets.some(p=>p.type==='ATTNWALL_SYNC'));
    const baseline=await page.evaluate(()=>window.packets.find(p=>p.type==='ATTNWALL_SYNC'));
    assert.ok(baseline.messages.every(m=>m.silent));assert.equal(baseline.completions.length,0);
    await page.evaluate(html=>{window.failNext=true;document.querySelector('main').insertAdjacentHTML('beforeend',html);},turn(1));
    await page.waitForFunction(()=>window.packets.some(p=>p.completions?.length),{timeout:15000});
    await page.waitForTimeout(3800);
    const packets=await page.evaluate(()=>window.packets);
    assert.equal(packets.flatMap(p=>p.completions||[]).length,1);
    const answer=packets.flatMap(p=>p.messages||[]).find(m=>m.body==='Answer 1');
    assert.ok(answer);assert.equal(answer.silent,false);
    assert.equal(packets.flatMap(p=>p.completions||[])[0].runId,answer.runId);
  });
});
