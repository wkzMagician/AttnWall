import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexAdapter} from '../src/adapters.js';
import {Store} from '../src/core.js';

test('Unchanged top threads do not starve completed runs below the read budget',async()=>{
  const messages=[],completed=[],reads=[];
  const adapter=new CodexAdapter(m=>messages.push(m),()=>{},c=>completed.push(c));
  adapter.ready=true;
  const threads=Array.from({length:5},(_,i)=>({id:'thread-'+i,updatedAt:100-i}));
  adapter.rpc.request=async()=>({data:threads});
  adapter.readRecent=async id=>{reads.push(id);return {turns:[{id:id+'-run',status:'completed',items:[{id:'final',type:'agentMessage',text:'Result'}]}]};};
  try{
    await adapter.sync();
    assert.equal(reads.length,3);
    await adapter.sync();
    assert.equal(reads.length,5,'Later polls advance beyond unchanged top three');
    assert.ok(messages.every(m=>m.silent),'Delayed first reads remain historical');
    threads[4].updatedAt=200;
    await adapter.sync();
    assert.equal(reads.at(-1),'thread-4');
    assert.equal(messages.at(-1).silent,false,'Changed known thread is live');
    assert.equal(completed.at(-1).nativeId,'thread-4');
  }finally{adapter.close();}
});

test('Polled external Codex runs reach the inbox only after completion and batch release',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'attnwall-sync-'));
  const store=new Store(join(dir,'test.db'));
  const sid=store.session({runtime:'codex',nativeId:'external-thread',title:'External'});
  const adapter=new CodexAdapter(
    message=>store.message({...message,sessionId:sid}),()=>{},
    completion=>store.completeRun(sid,completion.runId,{status:completion.status})
  );
  adapter.ready=true;
  adapter.rpc.request=async()=>({data:[{id:'external-thread'}]});
  let turns=[{id:'history',status:'completed',items:[{id:'old',type:'agentMessage',text:'Old result'}]}];
  adapter.readRecent=async()=>({turns});
  try{
    await adapter.sync();
    assert.equal(store.unreadCount(),0,'First discovery imports history silently');
    assert.equal(store.pendingNotifications().length,0);
    turns.push({id:'live',status:'inProgress',items:[{id:'progress',type:'agentMessage',text:'Working'}]});
    await adapter.sync();
    assert.equal(store.pendingNotifications().length,0,'Running turns cannot notify');
    turns[1]={id:'live',status:'completed',items:[
      {id:'progress',type:'agentMessage',text:'Working'},
      {id:'final',type:'agentMessage',text:'Finished'}
    ]};
    await adapter.sync();
    assert.equal(store.pendingNotifications().length,1,'Polled completion starts one batch');
    assert.equal(store.readyInbox().length,0,'Ordinary messages wait for delivery');
    await adapter.sync();
    assert.equal(store.pendingNotifications().length,1,'Repeated polling is idempotent');
    store.claimNotificationBatch(Date.now());
    assert.equal(store.readyInbox().length,1);
    assert.equal(store.readyInbox()[0].body,'Finished');
  }finally{adapter.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('First poll after restart recovers an unread run missing its completion',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'attnwall-sync-restart-'));
  const store=new Store(join(dir,'test.db'));
  const sid=store.session({runtime:'codex',nativeId:'external-thread',title:'External'});
  store.message({sessionId:sid,externalId:'turn:live:final',runId:'live',body:'Finished'});
  const adapter=new CodexAdapter(
    message=>store.message({...message,sessionId:sid}),()=>{},
    completion=>store.completeRun(sid,completion.runId,{status:completion.status})
  );
  adapter.ready=true;
  adapter.rpc.request=async()=>({data:[{id:'external-thread'}]});
  adapter.readRecent=async()=>({turns:[{id:'live',status:'failed',items:[{id:'final',type:'agentMessage',text:'Finished'}]}]});
  try{
    await adapter.sync();
    assert.equal(store.unreadCount(),1);
    assert.equal(store.pendingNotifications().length,1);
    assert.equal(store.db.prepare('SELECT status FROM run_completions').get().status,'failed');
  }finally{adapter.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('A new desktop conversation that finishes between polls is live, not silent history',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'attnwall-new-run-')),store=new Store(join(dir,'store.db'));
  const id=store.session({runtime:'codex',nativeId:'new-thread',title:'New task'});
  const adapter=new CodexAdapter(m=>store.message({...m,sessionId:id}),()=>{},c=>store.completeRun(id,c.runId));
  adapter.ready=true;let threads=[];
  adapter.rpc.request=async()=>({data:threads});
  adapter.readRecent=async()=>({turns:[{id:'new-run',status:'completed',items:[{id:'final',type:'agentMessage',text:'Task finished'}]}]});
  try{
    await adapter.sync();
    threads=[{id:'new-thread',createdAt:adapter.discoveryStartedAt+1,updatedAt:adapter.discoveryStartedAt+2}];
    await adapter.sync();await adapter.sync();
    assert.equal(store.unreadCount(),1);assert.equal(store.pendingNotifications().length,1);
    store.claimNotificationBatch();assert.equal(store.readyInbox()[0].body,'Task finished');
  }finally{adapter.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('First import of an older desktop conversation notifies only runs started while watching',async()=>{
  const messages=[],adapter=new CodexAdapter(m=>messages.push(m));adapter.ready=true;
  let threads=[];adapter.rpc.request=async()=>({data:threads});
  adapter.readRecent=async()=>({turns:[
    {id:'history',startedAt:adapter.discoveryStartedAt-3600,status:'completed',items:[{id:'old',type:'agentMessage',text:'Old history'}]},
    {id:'live',startedAt:adapter.discoveryStartedAt+1,status:'completed',items:[{id:'new',type:'agentMessage',text:'Live result'}]}
  ]});
  try{
    await adapter.sync();threads=[{id:'old-thread',createdAt:adapter.discoveryStartedAt-86400}];await adapter.sync();
    assert.equal(messages.find(m=>m.body==='Old history').silent,true);
    assert.equal(messages.find(m=>m.body==='Live result').silent,false);
  }finally{adapter.close();}
});

test('First startup snapshot remains silent even for recently created desktop threads',async()=>{
  const messages=[],adapter=new CodexAdapter(m=>messages.push(m));adapter.ready=true;
  adapter.rpc.request=async()=>({data:[{id:'initial-thread',createdAt:adapter.discoveryStartedAt+1}]});
  adapter.readRecent=async()=>({turns:[{id:'initial',startedAt:adapter.discoveryStartedAt+1,status:'completed',items:[{id:'first',type:'agentMessage',text:'Startup history'}]}]});
  try{await adapter.sync();assert.equal(messages[0].silent,true);}finally{adapter.close();}
});
