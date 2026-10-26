import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core.js';
import {NotificationScheduler} from '../src/notify.js';

const minute=60000;
async function fixture(run){
  const dir=mkdtempSync(join(tmpdir(),'attnwall-batch-start-'));
  let store=new Store(join(dir,'test.db'));
  const base=Date.now(),sid=store.session({runtime:'codex',nativeId:'timing'}),notices=[];
  store.updateSettings({intervalMin:20,dndEnabled:false});
  const scheduler=()=>new NotificationScheduler(store,{vapidFile:join(dir,'vapid.json'),broadcast:(_type,payload)=>notices.push(payload)});
  let sender=scheduler();
  const ctx={sid,base,notices,get store(){return store;},get sender(){return sender;},
    start:(id,time)=>store.startRun(sid,id,{at:base+time*minute}),
    finish:(id,time)=>{
      store.message({sessionId:sid,externalId:id,runId:id,body:'Final '+id,createdAt:base+time*minute});
      store.completeRun(sid,id,{at:base+time*minute});
    },
    tick:time=>sender.tick(base+time*minute),
    restart:()=>{store.close();store=new Store(join(dir,'test.db'));sender=scheduler();}
  };
  try{await run(ctx);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
}

test('Short task: start at 0, finish at 5, notify at 20',()=>fixture(async c=>{
  assert.equal(c.sender.nextAt,null);
  c.start('A',0);
  assert.equal(c.sender.nextAt,c.base+20*minute,'Clock begins before any output');
  c.finish('A',5);
  assert.equal(c.sender.nextAt,c.base+20*minute);
  await c.tick(19);assert.equal(c.store.readyUnreadCount(),0);
  await c.tick(20);assert.equal(c.store.readyUnreadCount(),1);
  assert.equal(c.notices.length,1);assert.equal(c.sender.nextAt,null);
}));

test('Long task: wait for completion at 30, then notify immediately',()=>fixture(async c=>{
  c.start('A',0);
  await c.tick(20);assert.equal(c.notices.length,0);
  assert.equal(c.store.lastBatchAt(),0,'An empty boundary creates no notification');
  c.finish('A',30);
  assert.equal(c.sender.nextAt,c.base+30*minute);
  await c.tick(30);assert.equal(c.notices.length,1);
  assert.equal(c.sender.nextAt,null);
}));

test('Overlapping tasks notify A at 20 and B at 40, including after restart',()=>fixture(async c=>{
  c.start('A',0);c.start('B',3);c.finish('A',5);
  c.restart();
  assert.equal(c.sender.nextAt,c.base+20*minute);
  await c.tick(20);
  assert.deepEqual(c.store.readyInbox().map(m=>m.body),['Final A']);
  c.restart();
  assert.equal(c.sender.nextAt,c.base+40*minute,'The next batch waits T from the previous notification');
  c.start('B',18);
  assert.equal(c.sender.nextAt,c.base+40*minute,'Repeated observations must not reset the clock');
  c.finish('B',30);await c.tick(30);
  assert.equal(c.store.readyUnreadCount(),1);assert.equal(c.notices.length,1);
  await c.tick(39);assert.equal(c.notices.length,1);
  await c.tick(40);
  assert.equal(c.store.readyUnreadCount(),2);assert.equal(c.notices.length,2);
  await c.tick(60);assert.equal(c.notices.length,2);
}));

test('A delayed tick excludes outputs completed after the original batch cutoff',()=>fixture(async c=>{
  c.start('A',0);c.start('B',3);c.start('C',7);
  c.finish('A',5);c.finish('B',21);c.finish('C',20);
  await c.tick(40);
  assert.deepEqual(c.store.readyInbox().map(m=>m.body).sort(),['Final A','Final C']);
  assert.deepEqual(c.store.pendingNotifications().map(m=>m.body),['Final B']);
  assert.equal(c.notices[0].count,2);
  assert.equal(c.sender.nextAt,c.base+60*minute,'Delay is measured from the actual release at 40');
  await c.tick(40);assert.equal(c.notices.length,1);
  await c.tick(60);assert.equal(c.notices.length,2);
  assert.equal(c.notices[1].count,1);
}));

test('The earliest unfinished task sets the window without blocking a shorter task',()=>fixture(async c=>{
  c.start('A',0);c.start('B',10);c.finish('B',15);
  await c.tick(20);
  assert.deepEqual(c.store.readyInbox().map(m=>m.body),['Final B']);
  c.finish('A',50);await c.tick(50);
  assert.equal(c.notices.length,2);assert.equal(c.store.readyUnreadCount(),2);
}));

test('A long first task shifts the next batch to 50, and a later idle task starts a fresh clock',()=>fixture(async c=>{
  c.start('A',0);c.start('B',3);
  c.finish('A',30);await c.tick(30);
  assert.equal(c.notices.length,1);
  c.finish('B',45);await c.tick(45);
  assert.equal(c.notices.length,1);
  assert.equal(c.sender.nextAt,c.base+50*minute);
  await c.tick(50);assert.equal(c.notices.length,2);
  assert.equal(c.sender.nextAt,null);
  c.start('C',100);c.finish('C',105);
  assert.equal(c.sender.nextAt,c.base+120*minute,'An idle gap does not turn the next task into an immediate notification');
  await c.tick(119);assert.equal(c.notices.length,2);
  await c.tick(120);assert.equal(c.notices.length,3);
}));

test('Upgrade recovers the first live output when old pending runs have no recorded start',()=>fixture(async c=>{
  c.store.message({sessionId:c.sid,runId:'old',body:'Working',createdAt:c.base});
  c.finish('old',10);
  c.store.db.exec('DELETE FROM run_starts');
  c.restart();
  assert.equal(c.sender.nextAt,c.base+20*minute,'Use the available first output rather than adding T after completion');
  await c.tick(20);assert.equal(c.store.readyUnreadCount(),1);
}));
