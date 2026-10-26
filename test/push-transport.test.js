import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import webpush from 'web-push';
import {Store} from '../src/core.js';
import {NotificationScheduler} from '../src/notify.js';
import {pushTransport,pushOptions,pushFailure} from '../src/push-transport.js';

test('Push honors Windows proxy unless an explicit setting or environment proxy overrides it',()=>{
  let reads=0;const windows={env:{},platform:'win32',readWindowsProxy:()=>{reads++;return '127.0.0.1:7890';}};
  assert.deepEqual(pushTransport(windows),{timeout:15000,proxy:'http://127.0.0.1:7890/'});
  assert.equal(pushTransport({...windows,env:{HTTPS_PROXY:'http://env-proxy:8080'}}).proxy,'http://env-proxy:8080/');
  assert.equal(pushTransport({...windows,env:{ATTNWALL_PUSH_PROXY:'http://explicit:9090',HTTPS_PROXY:'http://env-proxy'}}).proxy,'http://explicit:9090/');
  assert.deepEqual(pushTransport({...windows,env:{ATTNWALL_PUSH_PROXY:'direct'}}),{timeout:15000});
  assert.deepEqual(pushTransport({...windows,platform:'linux'}),{timeout:15000});
  assert.equal(reads,1);
});

test('Push respects NO_PROXY without bypassing unrelated hosts',()=>{
  const transport={timeout:15000,proxy:'http://proxy:8080'};
  assert.deepEqual(pushOptions('https://web.push.apple.com/path',transport,{env:{NO_PROXY:'.apple.com'}}),{timeout:15000});
  assert.deepEqual(pushOptions('https://fcm.googleapis.com/path',transport,{env:{NO_PROXY:'.apple.com'}}),transport);
  assert.deepEqual(pushOptions('https://fcm.googleapis.com/path',transport,{env:{NO_PROXY:'*'}}),{timeout:15000});
  assert.deepEqual(pushOptions('https://fcm.googleapis.com/path',transport,{env:{NO_PROXY:'fcm.googleapis.com:8443'}}),transport);
});

test('AggregateError retains the network cause without exposing private URLs',()=>{
  const error=new AggregateError([Object.assign(new Error('connect https://private.example/secret-token'),{code:'ETIMEDOUT'})]);
  assert.match(pushFailure(error).reason,/ETIMEDOUT/);
  assert.match(pushFailure(error).reason,/推送代理/);
  assert.equal(pushFailure(error).code,null);
  assert.match(pushFailure(new Error('Socket timeout')).reason,/ETIMEDOUT/);
  const redacted=pushFailure(new Error('Cannot connect to http://user:password@proxy:8080/secret'));
  assert.doesNotMatch(redacted.reason,/password|secret/);
  assert.equal(pushFailure({statusCode:410,body:'{"reason":"Unregistered"}'}).reason,'Unregistered');
});

test('A failed Windows push preserves other device delivery, subscriptions, and inbox notifications',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-push-')),store=new Store(join(dir,'store.db'));
  const original=webpush.sendNotification,calls=[],notices=[];
  try{
    store.updateSettings({dndEnabled:false});
    for(const [host,name] of [['fcm.googleapis.com','Windows'],['web.push.apple.com','iPhone']])store.saveSubscription({endpoint:'https://'+host+'/private-subscription',keys:{p256dh:'test',auth:'test'}},name);
    const sender=new NotificationScheduler(store,{vapidFile:join(dir,'vapid.json'),transport:{timeout:15000,proxy:'http://127.0.0.1:7890'},broadcast:(type,payload)=>notices.push(payload)});
    webpush.sendNotification=async(subscription,payload,options)=>{
      calls.push(options);
      if(subscription.endpoint.includes('googleapis'))throw new AggregateError([Object.assign(new Error(''),{code:'ETIMEDOUT'})]);
      return {statusCode:201};
    };
    const report=await sender.send({kind:'batch',title:'Test',body:'Test'});
    assert.equal(notices.length,1);
    assert.equal(report.results.find(r=>r.name==='iPhone').accepted,true);
    assert.match(report.results.find(r=>r.name==='Windows').reason,/ETIMEDOUT/);
    assert.equal(store.subscriptions().length,2,'Network failure must not delete the subscription');
    assert.ok(calls.every(options=>options.timeout===15000&&options.proxy==='http://127.0.0.1:7890'));
    assert.deepEqual(sender.lastReport(),report);
  }finally{webpush.sendNotification=original;store.close();rmSync(dir,{recursive:true,force:true});}
});
