import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createBadgeSynchronizer} from '../public/app-badge.js';

test('App icon badge reflects released unread totals and clears on read',async()=>{
  const calls=[];
  const sync=createBadgeSynchronizer({
    async setAppBadge(n){calls.push(['set',n]);},
    async clearAppBadge(){calls.push(['clear']);}
  });
  await sync(0);
  await sync(8);
  await sync(8);
  await sync(2);
  await sync(0);
  assert.deepEqual(calls,[['clear'],['set',8],['set',2],['clear']]);
});

test('Badge writes are ordered and denied or missing APIs never block the inbox',async()=>{
  const calls=[];
  let finishFirst;
  const sync=createBadgeSynchronizer({
    setAppBadge(n){calls.push(['set',n]);return new Promise(resolve=>{finishFirst=resolve;});},
    clearAppBadge(){calls.push(['clear']);}
  });
  const first=sync(3),second=sync(0);
  await Promise.resolve();
  assert.deepEqual(calls,[['set',3]]);
  finishFirst();
  await Promise.all([first,second]);
  assert.deepEqual(calls,[['set',3],['clear']]);

  const failing=createBadgeSynchronizer({
    async setAppBadge(){throw Error('NotAllowedError');},
    async clearAppBadge(){throw Error('NotAllowedError');}
  });
  await failing(5);await failing(0);
  await createBadgeSynchronizer({})(42);
  await createBadgeSynchronizer({setAppBadge:async()=>{}})(-1);
});

function mockWorker(badgeApi={}){
  const handlers={},calls=[];
  const self={
    navigator:badgeApi,
    location:{origin:'https://example.test'},
    registration:{async showNotification(title,options){calls.push(['notification',title,options]);}},
    addEventListener(type,fn){handlers[type]=fn;}
  };
  const source=readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');
  runInNewContext(source,{self,URL,Promise});
  async function push(payload){
    let task;
    handlers.push({data:{json(){return payload;}},waitUntil(promise){task=promise;}});
    await task;
  }
  return {calls,push};
}

test('Background push sets icon count, clears zero and ignores diagnostic pushes',async()=>{
  const worker=mockWorker({
    async setAppBadge(n){worker.calls.push(['set',n]);},
    async clearAppBadge(){worker.calls.push(['clear']);}
  });
  await worker.push({kind:'batch',title:'Batch',unreadCount:12});
  await worker.push({kind:'instant',title:'Instant',unreadCount:0});
  await worker.push({kind:'test',title:'Test'});
  assert.deepEqual(worker.calls.map(x=>x[0]),['notification','set','notification','clear','notification']);
  assert.deepEqual(worker.calls.filter(x=>x[0]==='set'),[['set',12]]);
  assert.equal(worker.calls[0][2].badge,'/icon.svg','NotificationOptions.badge is an image, not the icon number');
});

test('Badge unsupported or rejected does not suppress Web Push notification',async()=>{
  const unsupported=mockWorker();
  await unsupported.push({title:'Important',unreadCount:3});
  assert.equal(unsupported.calls.length,1);
  const denied=mockWorker({async setAppBadge(){throw new Error('denied');}});
  await denied.push({title:'Important',unreadCount:3});
  assert.equal(denied.calls.length,1);
});

test('Retries reuse a system notification tag while distinct events remain separate',async()=>{
  const worker=mockWorker();
  await worker.push({kind:'instant',notificationId:'event-1',title:'Original'});
  await worker.push({kind:'instant',notificationId:'event-1',title:'Retry'});
  await worker.push({kind:'instant',notificationId:'event-2',title:'Next'});
  assert.equal(worker.calls[0][2].tag,worker.calls[1][2].tag);
  assert.notEqual(worker.calls[1][2].tag,worker.calls[2][2].tag);
});
