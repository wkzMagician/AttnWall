import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexAdapter} from '../src/adapters.js';
import {queueCodexMessage} from '../src/codex-queue.js';

test('Codex Desktop writer conflict uses the official queue for the exact original thread',async()=>{
  const messages=[],completions=[],sessions=[],calls=[],queued=[];
  const a=new CodexAdapter(m=>messages.push(m),s=>sessions.push(s),c=>completions.push(c));a.ready=true;
  a.openWriter=async()=>a.rpc;
  const old={id:'old-turn',status:'completed',items:[{type:'userMessage',id:'old-user',content:[{type:'text',text:'Repeat'}]},{type:'agentMessage',id:'old-agent',text:'Old answer'}]};
  let turns=[old];
  a.readRecent=async()=>({id:'original-thread',turns});
  a.rpc.request=async(method,params)=>{
    calls.push({method,params});
    if(method==='thread/resume')throw new Error('thread original-thread already has an active writer');
    assert.equal(method,'thread/read');assert.equal(params.threadId,'original-thread');
    return {thread:{id:'original-thread',turns}};
  };
  a.queuePrompt=async(id,text)=>{queued.push({id,text});return {queued:true,queueId:'queue-1',nativeId:id};};
  const receipt=await a.send('original-thread','Repeat');
  assert.equal(receipt.queueId,'queue-1');assert.deepEqual(queued,[{id:'original-thread',text:'Repeat'}]);
  await a.pollQueued();assert.equal(messages.length,0);assert.equal(completions.length,0);
  assert.equal(a.queuedThreads.size,1,'An identical old user turn does not acknowledge a new queued message');
  turns=[old,{id:'new-turn',status:'inProgress',items:[{type:'userMessage',id:'new-user',content:[{type:'text',text:'Repeat'}]},{type:'agentMessage',id:'new-agent',text:'Progress'}]}];
  await a.pollQueued();assert.equal(completions.length,0);assert.equal(messages.length,0,'Streaming snapshots must not freeze incomplete text');
  turns[1]={...turns[1],status:'completed',items:[turns[1].items[0],{type:'agentMessage',id:'new-agent',text:'Receipt'}]};
  await a.pollQueued();await a.pollQueued();
  assert.equal(completions.length,1);assert.equal(completions[0].runId,'new-turn');
  assert.equal(messages.at(-1).body,'Receipt');assert.equal(sessions.at(-1).status,'idle');
  assert.equal(a.queuedThreads.size,0);
  assert.ok(calls.every(c=>!['thread/start','turn/start','turn/steer'].includes(c.method)));
});

test('Unrelated Codex resume failures never queue or resend the prompt',async()=>{
  const a=new CodexAdapter();a.ready=true;let queues=0;
  a.openWriter=async()=>a.rpc;
  a.rpc.request=async()=>{throw new Error('Authentication failed');};
  a.queuePrompt=async()=>{queues++;};
  await assert.rejects(a.send('original-thread','Message'),/Authentication failed/);
  assert.equal(queues,0);
});

test('Codex history uses bounded API pages and never requests full turns',async()=>{
  const a=new CodexAdapter();a.ready=true;const calls=[];
  a.rpc.request=async(method,params)=>{
    calls.push({method,params});
    if(method==='thread/read')return {thread:{id:'large-thread',status:{type:'idle'}}};
    assert.equal(method,'thread/turns/list');
    return {data:[['t3','Third',1700000003],['t2','Second',1700000002],['t1','First',1700000001]].map(([id,label,startedAt])=>({id,status:'completed',startedAt,items:[
      {type:'userMessage',id:'u'+id,content:[{type:'text',text:label+' question'}]},
      {type:'commandExecution',id:'tool'+id},
      {type:'agentMessage',id:'a'+id,text:label+' answer'}
    ]})),nextCursor:'older-turns'};
  };
  const history=await a.history('large-thread');
  assert.equal(history.length,5);assert.equal(history[0].body,'First answer');assert.equal(history.at(-1).body,'Third answer');
  assert.deepEqual(calls.find(c=>c.method==='thread/read').params,{threadId:'large-thread',includeTurns:false});
  assert.deepEqual(calls.find(c=>c.method==='thread/turns/list').params,{threadId:'large-thread',limit:3,sortDirection:'desc',itemsView:'summary'});
  assert.equal(calls.length,2,'A nextCursor must not trigger automatic deep history reads');
});

test('Codex CLI queue passes quotes, newlines and shell metacharacters as literal argv',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-codex-argv-'));
  try{
    const entry=join(dir,'fake codex.mjs'),capture=join(dir,'args.json');
    writeFileSync(entry,"import {writeFileSync} from 'node:fs';writeFileSync(process.env.ATTNWALL_TEST_ARGV,JSON.stringify(process.argv.slice(2)));console.log('Queued message test-queue-id for thread original-thread.');");
    const text='中文 "quotes" & echo UNEXPECTED | <file> %PATH% $(whoami) `literal`\nsecond line';
    const receipt=await queueCodexMessage('original-thread',text,{executable:entry,env:{...process.env,ATTNWALL_TEST_ARGV:capture}});
    assert.equal(receipt.queueId,'test-queue-id');
    assert.deepEqual(JSON.parse(readFileSync(capture,'utf8')),['queue','--thread','original-thread','--message',text]);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('A queue response for another thread is uncertain and cannot mark a reply sent',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-codex-receipt-'));
  try{
    const entry=join(dir,'fake.mjs');writeFileSync(entry,"console.log('Queued message test-queue-id for thread other-thread.');");
    await assert.rejects(queueCodexMessage('original-thread','Message',{executable:entry}),/回执不确定/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
