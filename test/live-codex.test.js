import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setTimeout as wait} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';

// Opt-in: this test sends a real prompt. Set an explicitly disposable test
// thread, never an existing work conversation. Credentials are never printed.
const nativeId=process.env.ATTNWALL_LIVE_CODEX_THREAD;
test('Live Codex: hub -> connector -> original thread -> assistant receipt and history',
  {skip:!nativeId,timeout:150000},async()=>{
    assert.match(nativeId,/^[a-f0-9-]{36}$/i,'An explicit Codex test thread ID is required');
    const {accessToken,connectorToken}=JSON.parse(readFileSync('.data/secrets.json','utf8'));
    const hub=process.env.ATTNWALL_LIVE_HUB||'http://127.0.0.1:3360';
    const host=process.env.ATTNWALL_LIVE_CODEX_HOST||'local';
    const sessionId=host+':codex:'+nativeId;
    async function api(path,body,token=accessToken){
      const r=await fetch(hub+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
      const data=await r.json();assert.equal(r.status,200,data.error||path);return data;
    }
    async function until(check,ms=90000){
      const end=Date.now()+ms;
      do{const value=await check();if(value)return value;await wait(500);}while(Date.now()<end);
      assert.fail('Timed out waiting for the real Codex connector');
    }
    // Agent-created Desktop test chats can be excluded from the CLI default
    // thread list. Register this exact authorized test ID without changing any
    // other conversation or its read state.
    await api('/api/connector/sync',{host,sessions:[{runtime:'codex',nativeId,title:'AttnWall 专用收发测试'}]},connectorToken);
    const detailPath='/api/messages?sessionId='+encodeURIComponent(sessionId);
    await api('/api/sessions/history',{sessionId,force:true});
    await until(async()=>{
      const d=await api(detailPath);if(d.history?.state==='error')assert.fail(d.history.error);
      return d.history?.state==='complete'&&d;
    });
    const receipt='ATTNWALL_CODEX_RECEIPT_'+randomUUID().replaceAll('-','');
    const text='ATTNWALL_CODEX_TEST_20261023：仅回复以下回执文本，不要调用工具或读取、修改文件：'+receipt;
    const replyId='live-codex-'+randomUUID();
    await api('/api/replies',{sessionId,text,id:replyId});
    const received=await until(async()=>{
      const d=await api(detailPath),reply=d.replies.find(r=>r.id===replyId);
      if(reply?.state==='failed')assert.fail(reply.error);
      return reply?.state==='sent'&&d.messages.some(m=>m.role==='agent'&&m.body.trim()===receipt)&&d;
    },100000);
    assert.ok(received.messages.some(m=>m.role==='user'&&m.body===text));
    await api('/api/sessions/history',{sessionId,force:true});
    await until(async()=>{
      const d=await api(detailPath);if(d.history?.state==='error')assert.fail(d.history.error);
      if(d.history?.state!=='complete')return false;
      assert.equal(d.messages.filter(m=>m.role==='user'&&m.body===text).length,1,'History must reconcile the original reply with its native echo');
      return d.messages.some(m=>m.role==='agent'&&m.body.trim()===receipt);
    });
  });
