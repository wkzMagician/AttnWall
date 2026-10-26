import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';

const chrome=process.env.ATTNWALL_CHROME||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome');
const options={skip:!existsSync(chrome)};
const root=resolve('extensions/browser'),manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
const config={kind:'attnwall-browser-v1',hub:'https://attnwall.example',browserToken:'a'.repeat(48)};

async function popup(initial,run){
  const browser=await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox']});
  try{
    const page=await browser.newPage({viewport:{width:360,height:620}});
    await page.addInitScript(({initial,version})=>{
      window.popupStore={...initial};window.createdTabs=[];window.permissionRequests=[];window.checkOK=true;
      window.chrome={
        runtime:{getManifest:()=>({version}),sendMessage:async()=>({ok:window.checkOK,error:window.checkOK?'':'Hub unavailable'})},
        storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,window.popupStore[key]])),set:async values=>Object.assign(window.popupStore,values)}},
        tabs:{query:async()=>[{url:'https://attnwall.example/'}],create:async value=>window.createdTabs.push(value)},
        permissions:{request:async value=>{window.permissionRequests.push(value);return true;}}
      };
    },{initial,version:manifest.version});
    await page.route('http://popup.test/**',async route=>{
      const name=new URL(route.request().url()).pathname.slice(1)||'popup.html',path=join(root,name);
      if(!existsSync(path)){await route.abort();return;}
      const type=name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':name.endsWith('.png')?'image/png':'text/html';
      await route.fulfill({contentType:type,body:readFileSync(path)});
    });
    await page.goto('http://popup.test/popup.html');await page.locator('#tab-title').getByText('当前页不可同步').waitFor();
    await run(page);
  }finally{await browser.close();}
}

test('Extension popup uses the coral theme, compact connected state and red packaged icons',options,async()=>{
  await popup({hub:config.hub,enabled:true,key:config.browserToken,bridgeStatus:{lastSyncedAt:Date.now()}},async page=>{
    assert.equal(await page.locator('#status-title').innerText(),'已配置');
    assert.equal(await page.locator('#connection-settings').getAttribute('open'),null);
    assert.equal(await page.locator('#connect').isDisabled(),true);
    assert.deepEqual(await page.evaluate(()=>({background:getComputedStyle(document.documentElement).backgroundColor,dot:getComputedStyle(document.getElementById('dot')).backgroundColor})),{background:'rgb(255, 248, 247)',dot:'rgb(204, 64, 85)'});
    assert.equal(await page.locator('.step,.hint').count(),0);
    for(const [size,asset] of Object.entries(manifest.icons)){
      const png=readFileSync(join(root,asset));assert.equal(png.readUInt32BE(16),Number(size));assert.equal(png.readUInt32BE(20),Number(size));
    }
  });
});

test('Popup validates configuration, connects, opens the hub and disconnects',options,async()=>{
  await popup({},async page=>{
    assert.equal(await page.locator('#connection-settings').getAttribute('open'),'');
    assert.equal(await page.locator('#disconnect').isDisabled(),true);
    await page.locator('#connection').fill('invalid JSON');await page.locator('#connect').click();
    assert.ok((await page.locator('#feedback').innerText()).length>0);
    assert.equal(await page.evaluate(()=>window.popupStore.enabled),undefined);
    await page.locator('#connection').fill(JSON.stringify(config));await page.locator('#connect').click();
    await page.locator('#feedback').getByText('已连接',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.popupStore.hub),config.hub);
    assert.equal(await page.evaluate(()=>window.popupStore.enabled),true);
    assert.equal(await page.locator('#connection').inputValue(),'');
    assert.deepEqual(await page.evaluate(()=>window.permissionRequests),[{origins:[config.hub+'/*']}]);
    await page.locator('#dashboard').click();assert.deepEqual(await page.evaluate(()=>window.createdTabs),[{url:config.hub}]);
    await page.locator('#disconnect').click();await page.locator('#feedback').getByText('已断开').waitFor();
    assert.equal(await page.evaluate(()=>window.popupStore.enabled),false);assert.equal(await page.evaluate(()=>window.popupStore.key),'');
    assert.equal(await page.locator('#connection-settings').getAttribute('open'),'');
  });
});

test('A connection check failure restores the prior popup configuration',options,async()=>{
  await popup({hub:'https://old.example',key:'b'.repeat(48),enabled:true},async page=>{
    await page.locator('#connection-settings summary').click();
    await page.evaluate(()=>{window.checkOK=false;});
    await page.locator('#connection').fill(JSON.stringify(config));await page.locator('#connect').click();
    await page.locator('#feedback').getByText('Hub unavailable').waitFor();
    assert.equal(await page.evaluate(()=>window.popupStore.hub),'https://old.example');
    assert.equal(await page.evaluate(()=>window.popupStore.enabled),true);
  });
});
