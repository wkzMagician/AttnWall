import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import net from 'node:net';
import {setTimeout as wait} from 'node:timers/promises';

async function availablePort(){
  const server=net.createServer();
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port;await new Promise(r=>server.close(r));return port;
}
test('HTTP login, cross-host session sync, durable reply pickup, and read sync',async()=>{
  const cwd=mkdtempSync(join(tmpdir(),'attnwall-http-')), port=await availablePort();
  const child=spawn(process.execPath,[resolve('src/server.js')],{
    cwd,env:{...process.env,ATTNWALL_PORT:String(port),ATTNWALL_LOCAL_CONNECTOR:'0'},
    stdio:['ignore','pipe','pipe'],windowsHide:true
  });
  const origin='http://127.0.0.1:'+port;
  try{
    let ready=false;
    for(let i=0;i<50;i++){try{const r=await fetch(origin+'/api/health');if(r.ok){ready=true;break;}}catch{}await wait(100);}
    assert.ok(ready,'server should start');
    const secrets=JSON.parse(readFileSync(join(cwd,'.data','secrets.json'),'utf8'));
    const unauth=await fetch(origin+'/api/state');assert.equal(unauth.status,401);
    const login=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:secrets.accessToken})});
    assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
    const ui=(method,url,data)=>fetch(origin+url,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
    const bridge=(method,url,data)=>fetch(origin+url,{method,headers:{Authorization:'Bearer '+secrets.connectorToken,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
    const first=await bridge('POST','/api/connector/sync',{host:'laptop',sessions:[{runtime:'codex',nativeId:'real-thread-1',title:'Smoke test'}],
      messages:[{runtime:'codex',nativeId:'real-thread-1',externalId:'msg-1',body:'Task done',runId:'codex-turn-1'}]});
    assert.equal(first.status,200);
    const dupe=await bridge('POST','/api/connector/sync',{host:'laptop',messages:[{runtime:'codex',nativeId:'real-thread-1',externalId:'msg-1',body:'Task done'}]});
    assert.equal((await dupe.json()).added,0);
    const state=await (await ui('GET','/api/state')).json();
    assert.equal(state.sessions.length,1);assert.equal(state.inbox.length,0);assert.equal(state.unreadCount,0);assert.equal(state.queuedNormal,0,'No notification before turn completion');
    const completed=await bridge('POST','/api/connector/sync',{host:'laptop',completions:[{runtime:'codex',nativeId:'real-thread-1',runId:'codex-turn-1'}]});
    assert.equal(completed.status,200);
    assert.equal((await (await ui('GET','/api/state')).json()).queuedNormal,1);    assert.deepEqual(state.pushDevices,[]);
    assert.equal(state.pushReport,null);
    const unknownPush=await ui('POST','/api/push/test',{deviceId:'unknown'});
    assert.equal(unknownPush.status,400,'Push tests require a registered device');
    const sid=state.sessions[0].id;
    await ui('POST','/api/sessions/history',{sessionId:sid});
    const noHistory=await (await bridge('GET','/api/connector/jobs?host=laptop&history=0')).json();
    assert.deepEqual(noHistory.historyRequests,[],'A busy history worker must not claim more reads');
    const queued=await ui('POST','/api/replies',{sessionId:sid,text:'Looks good',id:'reply-1'});
    assert.equal(queued.status,200);
    const jobs=await (await bridge('GET','/api/connector/jobs?host=laptop')).json();
    assert.equal(jobs.jobs.length,1);assert.equal(jobs.jobs[0].native_id,'real-thread-1');
    assert.equal((await bridge('POST','/api/connector/ack',{id:'reply-1',state:'sent'})).status,200);
    const messages=await (await ui('GET','/api/messages?sessionId='+encodeURIComponent(sid))).json();
    assert.equal(messages.messages.length,2);
    assert.equal(messages.messages.at(-1).role,'user');
    assert.equal((await ui('POST','/api/messages/read',{ids:[messages.messages[0].id]})).status,200);
    assert.equal((await (await ui('GET','/api/state')).json()).inbox.length,0);
    const settings=await ui('POST','/api/settings',{intervalMin:25,dndStart:'23:00',dndEnd:'07:00',timeZone:'Asia/Singapore'});
    assert.equal(settings.status,200);
    assert.equal((await settings.json()).settings.intervalMin,25);
    const index=await fetch(origin+'/');assert.equal(index.status,200);assert.match(await index.text(),/AttnWall/);
  }finally{child.kill();if(child.exitCode===null)await Promise.race([new Promise(resolve=>child.once('exit',resolve)),wait(3000)]);rmSync(cwd,{recursive:true,force:true,maxRetries:10,retryDelay:150});}
});
