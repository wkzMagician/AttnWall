import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexAdapter} from '../src/adapters.js';
import {Store} from '../src/core.js';

async function fixture(t,run){
  const dir=mkdtempSync(join(tmpdir(),'attnwall-reconcile-'));
  const store=new Store(join(dir,'test.db')),base=Date.now();let now=base;
  t.mock.method(Date,'now',()=>now);
  const sessions=[],completed=[];
  const sid=id=>store.session({runtime:'codex',nativeId:id,title:id});
  const adapter=new CodexAdapter(
    m=>store.message({...m,sessionId:sid(m.nativeId)}),
    s=>{sessions.push(s);store.session(s);},
    c=>{completed.push(c);store.completeRun(sid(c.nativeId),c.runId,{at:c.at,status:c.status});},
    r=>store.startRun(sid(r.nativeId),r.runId,{at:r.at})
  );
  adapter.ready=true;
  let threads=[{id:'desktop',createdAt:base/1000-3600,updatedAt:base/1000-3600,status:{type:'notLoaded'}}];
  let turns=[{id:'old',status:'completed',startedAt:base/1000-3600,completedAt:base/1000-3500,items:[{id:'old-final',type:'agentMessage',text:'Old result'}]}];
  adapter.rpc.request=async()=>({data:threads});
  adapter.readRecent=async()=>({id:'desktop',updatedAt:now/1000,turns});
  const context={adapter,store,dir,base,sid,sessions,completed,
    setNow:value=>now=value,setThreads:value=>threads=value,setTurns:value=>turns=value,
    final:(id='live')=>({id,status:'completed',startedAt:(base+1000)/1000,completedAt:(base+5000)/1000,
      items:[{id:id+'-final',type:'agentMessage',text:'Finished '+id}]})};
  try{await run(context);}finally{adapter.close();store.close();rmSync(dir,{recursive:true,force:true});}
}

test('A frozen Desktop list timestamp is revalidated and releases exactly one final result',t=>fixture(t,async c=>{
  await c.adapter.sync();
  c.setTurns([c.final()]);c.setNow(c.base+61000);
  await c.adapter.sync();await c.adapter.sync();
  assert.equal(c.store.pendingNotifications().length,1);
  assert.equal(c.store.pendingNotifications()[0].body,'Finished live');
  c.store.claimNotificationBatch();
  assert.equal(c.store.readyUnreadCount(),1);
}));

test('Rollout file changes trigger a read even when list time and unloaded status are frozen',t=>fixture(t,async c=>{
  const path=join(c.dir,'rollout.jsonl');writeFileSync(path,'initial');
  c.setThreads([{id:'desktop',path,updatedAt:1,status:{type:'notLoaded'}}]);
  await c.adapter.sync();
  c.setTurns([c.final()]);writeFileSync(path,'new turn and final output');
  await c.adapter.sync();
  assert.equal(c.store.pendingNotifications().length,1);
}));

test('A foreign running turn reported interrupted without an end time stays active until its real completion',t=>fixture(t,async c=>{
  c.setTurns([{id:'live',status:'interrupted',startedAt:(c.base-10000)/1000,completedAt:null,
    items:[{id:'partial',type:'agentMessage',text:'Partial output'}]}]);
  await c.adapter.sync();
  assert.equal(c.completed.length,0);
  assert.equal(c.store.messages(c.sid('desktop')).length,0);
  assert.equal(c.sessions.at(-1).status,'active');
  const final=c.final();final.startedAt=(c.base-10000)/1000;c.setTurns([final]);
  await c.adapter.sync();
  assert.equal(c.completed.length,1);assert.equal(c.completed[0].status,'completed');
  assert.equal(c.completed[0].at,c.base+5000);
  assert.equal(c.store.pendingNotifications().length,1);
  assert.equal(c.sessions.at(-1).status,'idle');
}));

test('Busy top conversations and failed reads cannot starve another completion',t=>fixture(t,async c=>{
  c.setThreads(Array.from({length:5},(_,i)=>({id:'thread-'+i,updatedAt:100-i,status:{type:'active'}})));
  const reads=[];
  c.adapter.readRecent=async id=>{
    reads.push(id);
    if(id==='thread-0')throw Error('Temporary read failure');
    return {turns:id==='thread-4'?[c.final()]:[{id:id+'-run',status:'inProgress',items:[]}]};
  };
  t.mock.method(console,'warn',()=>{});
  for(let i=0;i<4;i++)await c.adapter.sync();
  assert.ok(reads.includes('thread-4'));
  assert.equal(c.store.pendingNotifications().length,1);
}));

test('Historical runs stay silent when periodic revalidation exposes more old messages',t=>fixture(t,async c=>{
  await c.adapter.sync();c.setNow(c.base+61000);
  c.setTurns([{id:'old',status:'completed',startedAt:c.base/1000-3600,completedAt:c.base/1000-3500,
    items:[{id:'previously-hidden',type:'agentMessage',text:'Another old result'}]}]);
  await c.adapter.sync();
  assert.equal(c.store.unreadCount(),0);assert.equal(c.store.pendingNotifications().length,0);
}));

test('A delayed first read of a baseline conversation still recognizes a run started while watching',t=>fixture(t,async c=>{
  c.setThreads(Array.from({length:4},(_,i)=>({id:'thread-'+i,createdAt:c.base/1000-86400,updatedAt:10-i})));
  c.adapter.readRecent=async id=>({turns:id==='thread-3'?[c.final()]:[]});
  await c.adapter.sync();await c.adapter.sync();
  assert.equal(c.store.pendingNotifications().length,1);
}));

test('Opening history before the background poll cannot silently consume a live final message',t=>fixture(t,async c=>{
  await c.adapter.sync();c.setTurns([c.final()]);
  const history=await c.adapter.history('desktop');
  for(const message of history)c.store.message({...message,sessionId:c.sid('desktop')});
  assert.equal(history[0].runId,'live');
  assert.equal(c.store.pendingNotifications().length,1);
  c.setNow(c.base+61000);await c.adapter.sync();
  assert.equal(c.store.pendingNotifications().length,1);
  assert.equal(c.store.messages(c.sid('desktop')).filter(m=>m.run_id==='live').length,1);
}));

test('History does not freeze a partial reply from a synthetic interrupted turn',t=>fixture(t,async c=>{
  await c.adapter.sync();
  c.setTurns([{id:'live',status:'interrupted',startedAt:(c.base+1000)/1000,completedAt:null,items:[
    {id:'user',type:'userMessage',content:[{type:'text',text:'Continue'}]},
    {id:'live-final',type:'agentMessage',text:'Partial'}
  ]}]);
  const history=await c.adapter.history('desktop');
  assert.deepEqual(history.map(m=>m.role),['user']);
  for(const message of history)c.store.message({...message,sessionId:c.sid('desktop')});
  await c.adapter.sync();assert.equal(c.sessions.at(-1).status,'active');
  c.setTurns([c.final()]);await c.adapter.sync();
  assert.equal(c.store.pendingNotifications()[0].body,'Finished live');
}));

test('Queued Desktop replies wait through synthetic interruption and retain their receipt until completion',t=>fixture(t,async c=>{
  let turns=[];
  c.adapter.readRecent=async()=>({turns});
  c.adapter.openWriter=async()=>c.adapter.rpc;
  c.adapter.rpc.request=async()=>{throw Error('thread desktop already has an active writer');};
  c.adapter.queuePrompt=async()=>({queueId:'receipt'});
  await c.adapter.send('desktop','Continue');
  turns=[{id:'live',status:'interrupted',startedAt:(c.base+1000)/1000,completedAt:null,items:[
    {id:'user',type:'userMessage',content:[{type:'text',text:'Continue'}]},
    {id:'live-final',type:'agentMessage',text:'Partial'}
  ]}];
  await c.adapter.pollQueued();
  assert.equal(c.completed.length,0);assert.equal(c.adapter.queuedThreads.size,1);
  turns=[c.final()];await c.adapter.pollQueued();await c.adapter.pollQueued();
  assert.equal(c.adapter.queuedThreads.size,0);assert.equal(c.completed.length,1);
  assert.equal(c.store.pendingNotifications()[0].body,'Finished live');
}));

test('Explicit interrupted completion with an end time remains a terminal result',t=>fixture(t,async c=>{
  await c.adapter.sync();
  const interrupted={...c.final(),status:'interrupted'};
  c.setTurns([interrupted]);c.setNow(c.base+61000);await c.adapter.sync();
  assert.equal(c.completed.at(-1).status,'interrupted');
  assert.equal(c.sessions.at(-1).status,'idle');
  assert.equal(c.store.pendingNotifications().length,1);
}));

test('A real completion corrects an old false failure without duplicating or delaying delivery',t=>fixture(t,async c=>{
  const id=c.sid('desktop');
  c.store.startRun(id,'live',{at:c.base});
  c.store.completeRun(id,'live',{status:'failed',at:c.base+1000});
  c.store.message({sessionId:id,runId:'live',externalId:'live-final',body:'Real final',createdAt:c.base+5000});
  c.store.completeRun(id,'live',{status:'completed',at:c.base+5000});
  assert.deepEqual({...c.store.db.prepare('SELECT status,completed_at FROM run_completions WHERE run_id=?').get('live')},
    {status:'completed',completed_at:c.base+5000});
  assert.equal(c.store.pendingNotifications().length,1);
  assert.equal(c.store.pendingNotifications()[0].queued_at,c.base+5000);
  c.store.claimNotificationBatch(c.base+6000);
  c.store.completeRun(id,'live',{status:'completed',at:c.base+61000});
  c.store.completeRun(id,'live',{status:'failed',at:c.base+62000});
  assert.equal(c.store.pendingNotifications().length,0);assert.equal(c.store.readyUnreadCount(),1);
  assert.equal(c.store.db.prepare('SELECT completed_at FROM run_completions WHERE run_id=?').get('live').completed_at,c.base+5000);
}));

test('Discovery rotates past the first 300 stale list entries',t=>fixture(t,async c=>{
  const cursors=[];
  c.adapter.rpc.request=async(method,{cursor})=>{
    cursors.push(cursor);
    const page=cursor?Number(cursor):0;
    return {data:[{id:page===3?'desktop':'thread-'+page,updatedAt:1}],nextCursor:page<3?String(page+1):null};
  };
  c.adapter.readRecent=async id=>({turns:id==='desktop'?[c.final()]:[]});
  await c.adapter.sync();await c.adapter.sync();
  assert.deepEqual(cursors,[null,'1','2',null,'3']);
  assert.equal(c.store.pendingNotifications().length,1);
}));
