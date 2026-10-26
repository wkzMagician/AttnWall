import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexAdapter} from '../src/adapters.js';

function setup(){
  const messages=[],completed=[],writers=[],adapter=new CodexAdapter(m=>messages.push(m),()=>{},c=>completed.push(c));
  adapter.ready=true;
  adapter.rpc.request=async()=>{throw new Error('The collector must never acquire a writer');};
  adapter.readRecent=async()=>({status:{type:'idle'},turns:[]});
  adapter.openWriter=async()=>{
    const writer=new EventEmitter();writer.calls=[];writer.closed=false;
    writer.request=async(method,params)=>{
      writer.calls.push({method,params});
      return method==='thread/start'?{thread:{id:'created-thread'}}:{};
    };
    writer.close=()=>{writer.closed=true;};
    writer.respond=(id,result)=>{writer.response={id,result};};
    adapter.bindRpc(writer);writers.push(writer);return writer;
  };
  return {adapter,messages,completed,writers};
}

test('A completed direct turn closes its dedicated writer, leaving the collector available',async()=>{
  const {adapter,messages,completed,writers}=setup();
  await adapter.send('original','Hello');
  const [writer]=writers;
  assert.equal(writer.closed,false);
  writer.emit('notification','item/completed',{threadId:'original',turnId:'turn1',item:{type:'agentMessage',id:'answer',text:'Done'}});
  writer.emit('notification','turn/completed',{threadId:'original',turn:{id:'turn1',status:'completed'}});
  assert.equal(messages[0].body,'Done');assert.equal(completed[0].runId,'turn1');
  assert.equal(writer.closed,true);assert.equal(adapter.writers.size,0);assert.equal(adapter.ready,true);
  await adapter.send('original','Next');assert.equal(writers.length,2);
  adapter.close();assert.equal(writers[1].closed,true);
});

test('Completing one thread does not close another thread writer',async()=>{
  const {adapter,writers}=setup();
  await adapter.send('first','One');await adapter.send('second','Two');
  writers[0].emit('notification','turn/completed',{threadId:'first',turn:{id:'t1',status:'completed'}});
  assert.equal(writers[0].closed,true);assert.equal(writers[1].closed,false);
  adapter.close();
});

test('Session creation closes its writer after naming the original thread',async()=>{
  const {adapter,writers}=setup();
  assert.equal((await adapter.create({title:'New task'})).nativeId,'created-thread');
  assert.deepEqual(writers[0].calls.map(c=>c.method),['thread/start','thread/name/set']);
  assert.equal(writers[0].closed,true);
});

test('A failed direct send releases its writer and approvals use the owning connection',async()=>{
  const {adapter,writers,messages}=setup();
  await adapter.send('original','Hello');const [writer]=writers;
  writer.emit('request',{id:7,method:'item/commandExecution/requestApproval',params:{threadId:'original',command:'example'}});
  await adapter.approve(messages[0].approvalKey,'decline');
  assert.deepEqual(writer.response,{id:7,result:{decision:'decline'}});
  writer.request=async()=>{throw new Error('Upstream failure');};
  await assert.rejects(adapter.send('original','Again'),/Upstream failure/);
  assert.equal(writer.closed,true);assert.equal(adapter.writers.size,0);
});

test('The dedicated writer is a directly owned process that exits on completion',{timeout:15000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'attnwall-writer-'));
  const adapter=new CodexAdapter();adapter.ready=true;
  try{
    const entry=join(dir,'fake codex.mjs');
    writeFileSync(entry,`
      import {createInterface} from 'node:readline';
      const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
      createInterface({input:process.stdin}).on('line',line=>{
        const f=JSON.parse(line);if(f.id===undefined)return;
        emit({id:f.id,result:{}});
        if(f.method==='turn/start')setTimeout(()=>emit({method:'turn/completed',params:{threadId:f.params.threadId,turn:{id:'t1',status:'completed'}}}),200);
      });
    `);
    adapter.rpc.executable=entry;
    adapter.readRecent=async()=>({status:{type:'idle'},turns:[]});
    await adapter.send('original','Hello');
    const writer=adapter.writers.get('original'),child=writer.child;
    assert.ok(child?.pid);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Writer process did not exit')),5000);
      child.once('exit',()=>{clearTimeout(timer);resolve();});
    });
    assert.equal(adapter.writers.size,0);assert.equal(writer.child,null);
    assert.equal(adapter.ready,true);
  }finally{adapter.close();rmSync(dir,{recursive:true,force:true});}
});
