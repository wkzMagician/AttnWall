import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core.js';
import {CodexAdapter} from '../src/adapters.js';
import {Connector} from '../src/connector.js';

test('Codex creation is host-bound, idempotent, and publishes only a real thread ID',()=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-codex-create-')),store=new Store(join(dir,'store.db'));
  try{
    const input={id:'request-1234',host:'desktop',title:'New task',cwd:'D:\\Workspace'};
    store.requestCodexSession(input);store.requestCodexSession(input);
    assert.equal(store.sessions().length,0);
    assert.equal(store.claimSessionCreations('other-host').length,0);
    const [request]=store.claimSessionCreations('desktop');assert.equal(request.id,input.id);
    assert.equal(store.claimSessionCreations('desktop').length,0);
    assert.throws(()=>store.finishSessionCreation('other-host',{id:input.id,nativeId:'wrong'}),/connector/);
    const complete=store.finishSessionCreation('desktop',{id:input.id,nativeId:'real-native-id',cwd:input.cwd});
    assert.equal(complete.session_id,'desktop:codex:real-native-id');
    assert.equal(store.sessionById(complete.session_id).title,'New task');
    assert.ok(store.sessionById(complete.session_id).activity_at>0);
    store.finishSessionCreation('desktop',{id:input.id,nativeId:'real-native-id'});
    assert.equal(store.sessions().length,1);
    assert.throws(()=>store.requestCodexSession({...input,host:'changed'}),/already used/);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('A native creation error does not leave a fake conversation in the sidebar',()=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-codex-create-error-')),store=new Store(join(dir,'store.db'));
  try{
    store.requestCodexSession({id:'request-1234'});store.claimSessionCreations('local');
    store.finishSessionCreation('local',{id:'request-1234',error:'Invalid working directory'});
    assert.equal(store.creationStatus('request-1234').state,'failed');assert.equal(store.sessions().length,0);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('Codex creates and names the thread, then sends to that same native thread',async()=>{
  const sessions=[],calls=[],adapter=new CodexAdapter(()=>{},s=>sessions.push(s));adapter.ready=true;
  adapter.openWriter=async()=>adapter.rpc;
  adapter.rpc.request=async(method,params)=>{calls.push({method,params});return method==='thread/start'?{thread:{id:'real-id',cwd:'D:\\Workspace'}}:{};};
  adapter.readRecent=async()=>({status:{type:'idle'},turns:[]});
  try{
    const result=await adapter.create({cwd:'D:\\Workspace',title:'New task'});
    assert.equal(result.nativeId,'real-id');assert.equal(sessions[0].nativeId,'real-id');
    assert.deepEqual(calls.map(c=>c.method),['thread/start','thread/name/set']);
    await adapter.send(result.nativeId,'First prompt');
    assert.equal(calls.at(-1).method,'turn/start');assert.equal(calls.at(-1).params.threadId,'real-id');
  }finally{adapter.close();}
});

test('A failed acknowledgment retries its receipt without creating another native thread',async()=>{
  const connector=new Connector({hub:'http://localhost',token:'test',host:'desktop'});
  connector.lastSync=Date.now();connector.codex.pollQueued=async()=>{};
  let claimed=false,created=0,posts=0;
  connector.codex.create=async request=>{created++;assert.equal(request.title,'New task');return {nativeId:'real-id',cwd:'D:\\Workspace'};};
  connector.api=async(method,path,body)=>{
    if(path.startsWith('/api/connector/jobs')){
      const jobs=claimed?[]:[{id:'request-1234',title:'New task',cwd:'D:\\Workspace'}];claimed=true;
      return {jobs:[],createRequests:jobs};
    }
    if(path==='/api/connector/sync'&&body.creations?.length){
      posts++;if(posts===1)throw new Error('Temporary connection failure');
      assert.equal(body.creations[0].nativeId,'real-id');
    }
    return {ok:true};
  };
  try{
    await connector.tick();await connector.creationTask;
    assert.equal(connector.creations.length,1);
    await connector.tick();assert.equal(connector.creations.length,0);
    assert.equal(created,1);assert.equal(posts,2);
  }finally{connector.stop();}
});
