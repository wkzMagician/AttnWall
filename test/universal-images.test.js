import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core.js';
import {CodexAdapter,DshAdapter} from '../src/adapters.js';
import {Connector} from '../src/connector.js';
import {queueCodexMessage} from '../src/codex-queue.js';

const image={type:'image/png',name:'picture.png',data:Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3]).toString('base64')};

for(const runtime of ['codex','dsh','chatgpt-web','codex-web','deepseek-web']){
  test(runtime+': image-only reply remains host-bound and survives failed delivery',()=>{
    const dir=mkdtempSync(join(tmpdir(),'aw-universal-')),store=new Store(join(dir,'test.db'));
    try{
      const id=store.session({host:'image-host',runtime,nativeId:'original-thread'});
      const reply=store.queueImageReply(id,'',image,'image-reply');
      assert.throws(()=>store.replyImage(reply.id,'image-host'),/unavailable/,'unclaimed data is unavailable');
      const [job]=store.claimReplies('image-host');
      assert.deepEqual(store.replyImage(job.id,'image-host'),image);
      assert.throws(()=>store.replyImage(job.id,'another-host'),/unavailable/);
      store.replyState(job.id,'failed','upstream unavailable');
      assert.throws(()=>store.replyImage(job.id,'image-host'),/unavailable/);
      store.replyState(job.id,'queued');store.claimReplies('image-host');
      assert.deepEqual(store.replyImage(job.id,'image-host'),image);
      store.replyState(job.id,'sent');
      assert.throws(()=>store.replyImage(job.id,'image-host'),/unavailable/);
      assert.equal(store.messages(id).at(-1).body,'[图片]');
    }finally{store.close();rmSync(dir,{recursive:true,force:true});}
  });
}

for(const active of [false,true])test('Codex '+(active?'steer':'start')+' sends image bytes with text',async()=>{
  const adapter=new CodexAdapter();adapter.ready=true;
  adapter.openWriter=async()=>adapter.rpc;
  const calls=[];
  adapter.readRecent=async()=>({status:{type:active?'active':'idle'},turns:active?[{id:'active-turn',status:'inProgress'}]:[]});
  adapter.rpc.request=async(method,params)=>{calls.push({method,params});return {};};
  await adapter.send('original','Inspect this',{image});
  const call=calls.at(-1);
  assert.equal(call.method,active?'turn/steer':'turn/start');
  assert.equal(call.params.threadId,'original');
  assert.deepEqual(call.params.input,[{type:'text',text:'Inspect this'},{type:'image',url:'data:image/png;base64,'+image.data}]);
});

test('DSH sends image-only inline blocks using its SDK image schema',async()=>{
  const adapter=new DshAdapter();adapter.ready=true;
  adapter.rpc.request=async(method,params)=>{
    assert.equal(method,'session/prompt');assert.equal(params.sessionId,'original');
    assert.deepEqual(params.contentBlocks,[{type:'image',data:image.data,mimeType:image.type}]);
  };
  await adapter.send('original','',{image});
});

test('Connector retrieves an image from its own host before forwarding and acknowledging',async()=>{
  const connector=new Connector({hub:'http://localhost',token:'test',host:'image-host'}),calls=[];
  connector.lastSync=Date.now();connector.codex.pollQueued=async()=>{};
  connector.codex.send=async(id,text,options)=>{calls.push('send');assert.equal(id,'original');assert.deepEqual(options,{image});};
  connector.api=async(method,path,data)=>{
    if(path.startsWith('/api/connector/jobs'))return {jobs:[{id:'image-job',native_id:'original',runtime:'codex',text:'',attachment_id:'attachment'}]};
    if(path==='/api/connector/attachment?host=image-host&id=image-job'){calls.push('image');return {image};}
    if(path==='/api/connector/ack'){calls.push(data.state);return {};}
    return {};
  };
  try{await connector.tick();assert.deepEqual(calls,['image','send','sent']);}finally{connector.stop();}
});

test('Connector never downgrades an unavailable image to a text-only reply',async()=>{
  const connector=new Connector({hub:'http://localhost',token:'test',host:'image-host'}),acks=[];
  connector.lastSync=Date.now();connector.codex.pollQueued=async()=>{};
  connector.codex.send=async()=>{assert.fail('Missing image must not reach the adapter');};
  connector.api=async(method,path,data)=>{
    if(path.startsWith('/api/connector/jobs'))return {jobs:[{id:'missing-image',runtime:'codex',native_id:'original',text:'Inspect this',attachment_id:'missing'}]};
    if(path.startsWith('/api/connector/attachment'))return {};
    if(path==='/api/connector/ack')acks.push(data);
    return {};
  };
  try{await connector.tick();assert.equal(acks[0].state,'failed');assert.match(acks[0].error,/图片附件不可用/);}finally{connector.stop();}
});

test('Codex queue passes a durable image file and releases it only after completion',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-image-queue-'));
  try{
    const entry=join(dir,'codex.mjs'),capture=join(dir,'args.json');
    writeFileSync(entry,"import {writeFileSync} from 'node:fs';writeFileSync(process.env.TEST_CAPTURE,JSON.stringify(process.argv.slice(2)));console.log('Queued message test-queue for thread original.');");
    const receipt=await queueCodexMessage('original','',{image,executable:entry,cwd:dir,env:{...process.env,TEST_CAPTURE:capture}});
    const args=JSON.parse(readFileSync(capture,'utf8'));
    assert.equal(args.at(-2),'--image');assert.equal(args.at(-1),receipt.imagePath);
    assert.equal(readFileSync(receipt.imagePath).toString('base64'),image.data);
    const adapter=new CodexAdapter();adapter.ready=true;
    adapter.openWriter=async()=>adapter.rpc;
    let turns=[];
    adapter.readRecent=async()=>({turns});
    adapter.rpc.request=async()=>{throw new Error('already has an active writer');};
    adapter.queuePrompt=async(id,text,options)=>{assert.deepEqual(options,{image});return receipt;};
    await adapter.send('original','',{image});
    await adapter.pollQueued();assert.ok(existsSync(receipt.imagePath));
    turns=[{id:'image-turn',status:'completed',items:[{type:'userMessage',id:'image-user',content:[{type:'image',url:'data:image/png;base64,'+image.data}]}]}];
    await adapter.pollQueued();assert.equal(existsSync(receipt.imagePath),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
