import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/core.js';

for(const runtime of ['codex','chatgpt-web'])test(runtime+': remote reply and its history echo appear once',()=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-echo-')),store=new Store(join(dir,'test.db'));
  try{
    const sessionId=store.session({host:'echo-host',runtime,nativeId:'echo-session'});
    store.queueReply(sessionId,'Repeated prompt','reply-one');store.claimReplies('echo-host');store.replyState('reply-one','sent');
    store.message({sessionId,externalId:'source-one',role:'user',body:'Repeated prompt',silent:true});
    store.replyState('reply-one','sent');
    assert.equal(store.messages(sessionId).length,1,'Repeated ACKs and history reads cannot duplicate a sent reply');
    // The same text in a later actual turn is still a distinct message.
    store.queueReply(sessionId,'Repeated prompt','reply-two');store.claimReplies('echo-host');
    store.message({sessionId,externalId:'source-one',role:'user',body:'Repeated prompt',silent:true});
    store.message({sessionId,externalId:'source-two',role:'user',body:'Repeated prompt',silent:true});
    store.replyState('reply-two','sent');
    assert.equal(store.messages(sessionId).length,2,'An echo arriving before its ACK is also reconciled');
    assert.deepEqual(store.messages(sessionId).map(m=>m.external_id).sort(),['source-one','source-two']);
    const other=store.session({host:'echo-host',runtime,nativeId:'other-session'});
    store.message({sessionId:other,externalId:'source-other',role:'user',body:'Repeated prompt'});
    assert.equal(store.messages(other).length,1,'Matching is scoped to the original session');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
