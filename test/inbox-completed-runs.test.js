import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core.js';

test('Existing released progress collapses into final replies without hiding action requests or history',()=>{
  const dir=mkdtempSync(join(tmpdir(),'attnwall-inbox-runs-'));
  let store=new Store(join(dir,'test.db'));
  try{
    const sid=store.session({runtime:'chatgpt-web',nativeId:'inbox-runs',title:'Web'});
    for(const runId of ['first','second']){
      for(let i=0;i<10;i++)store.message({sessionId:sid,externalId:runId+i,runId,body:runId+i,createdAt:1000});
      store.completeRun(sid,runId);
    }
    store.claimNotificationBatch();
    // A pre-upgrade database has notified_at on every progress message.
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM messages WHERE notified_at IS NOT NULL').get().n,20);
    store.close();store=new Store(join(dir,'test.db'));
    assert.deepEqual(store.readyInbox().map(m=>m.body).sort(),['first9','second9']);
    assert.equal(store.readyUnreadCount(),2);
    assert.equal(store.readyUnreadCount(sid),2);
    assert.equal(store.readySessions()[0].unread,2);
    assert.equal(store.messages(sid).length,20);
    const final=store.readyInbox().find(m=>m.run_id==='first');
    store.readMessages([final.id]);
    assert.equal(store.readyUnreadCount(),1,'Reading a final reply must not resurface its progress');
    store.message({sessionId:sid,externalId:'new-progress',runId:'third',body:'Still running'});
    assert.equal(store.readyUnreadCount(),1);
    const action=store.message({sessionId:sid,externalId:'approval',runId:'third',kind:'approval',body:'Please approve'});
    assert.equal(store.readyUnreadCount(),2,'Action requests remain immediately visible');
    store.message({sessionId:sid,externalId:'new-final',runId:'third',body:'Done'});
    store.completeRun(sid,'third');store.claimNotificationBatch();
    assert.equal(store.readyUnreadCount(),3);
    assert.ok(store.readyInbox().some(m=>m.id===action.id));
    store.markAllRead(sid);
    assert.equal(store.readyUnreadCount(),0);
    assert.equal(store.readyInbox().length,0);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
