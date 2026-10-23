import test from 'node:test';
import assert from 'node:assert/strict';
import {Connector} from '../src/connector.js';
import {CodexAdapter} from '../src/adapters.js';

test('Slow session discovery cannot block the next remote reply',{timeout:5000},async()=>{
  const c=new Connector({hub:'http://127.0.0.1:1',token:'test',host:'testhost'}),sent=[],acks=[];
  let release,job=null;
  c.codex.sync=()=>new Promise(r=>release=r);
  c.codex.pollQueued=async()=>{};
  c.codex.send=async(id,text)=>sent.push({id,text});
  c.api=async(method,path,data)=>{
    if(path.startsWith('/api/connector/jobs'))return {jobs:job?[job]:[],historyRequests:[]};
    if(path==='/api/connector/ack')acks.push(data);
    return {ok:true};
  };
  try{
    await c.tick();
    job={id:'reply-1',runtime:'codex',native_id:'original',text:'Urgent follow-up',kind:'message'};
    await c.tick();
    assert.deepEqual(sent,[{id:'original',text:'Urgent follow-up'}]);
    assert.equal(acks[0].state,'sent');
  }finally{release?.();c.stop();}
});

test('A pending history read does not delay replies or claim additional history',{timeout:5000},async()=>{
  const c=new Connector({hub:'http://127.0.0.1:1',token:'test',host:'testhost'}),paths=[],sent=[];
  let release,round=0;
  c.lastSync=Date.now();c.codex.pollQueued=async()=>{};
  c.codex.history=()=>new Promise(r=>release=()=>r([]));
  c.codex.send=async(id,text)=>sent.push({id,text});
  c.api=async(method,path)=>{
    if(path.startsWith('/api/connector/jobs')){
      paths.push(path);round++;
      return round===1?{jobs:[],historyRequests:[{native_id:'slow-history',session_id:'history-session'}]}:
        {jobs:[{id:'reply-2',runtime:'codex',native_id:'original',text:'Reply while loading',kind:'message'}],historyRequests:[]};
    }
    return {ok:true};
  };
  try{
    await c.tick();await c.tick();
    assert.deepEqual(sent,[{id:'original',text:'Reply while loading'}]);
    assert.match(paths[1],/history=0/);
  }finally{release?.();c.stop();}
});

test('Concurrent Codex operations initialize their one RPC connection once',async()=>{
  const a=new CodexAdapter(),requests=[],notices=[];let starts=0;
  a.rpc.start=async()=>{starts++;};
  a.rpc.request=async(method)=>{requests.push(method);await Promise.resolve();return {};};
  a.rpc.notify=method=>notices.push(method);
  await Promise.all([a.start(),a.start(),a.start()]);
  assert.equal(starts,1);assert.deepEqual(requests,['initialize']);assert.deepEqual(notices,['initialized']);
});

test('Concurrent buffer flushes preserve messages and newer session updates',async()=>{
  const c=new Connector({hub:'http://127.0.0.1:1',token:'test',host:'testhost'}),batches=[];
  let release;
  c.onSession({runtime:'codex',nativeId:'original',title:'Original title',status:'idle'});
  c.onMessage({runtime:'codex',nativeId:'original',body:'First'});
  c.api=async(method,path,data)=>{batches.push(structuredClone(data));await new Promise(r=>release=r);return {ok:true};};
  const first=c.flush(),same=c.flush();
  c.onSession({runtime:'codex',nativeId:'original',status:'active'});
  c.onMessage({runtime:'codex',nativeId:'original',body:'Second'});
  release();await Promise.all([first,same]);
  assert.equal(batches.length,1,'Simultaneous consumers cannot splice the same batch twice');
  assert.deepEqual(c.messages.map(m=>m.body),['Second']);
  assert.deepEqual(c.sessions,[{runtime:'codex',nativeId:'original',title:'Original title',status:'active'}]);
  const second=c.flush();release();await second;
  assert.equal(c.messages.length,0);assert.equal(c.sessions.length,0);c.stop();
});
