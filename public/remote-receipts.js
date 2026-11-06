// Shared by the page and service worker so a push and a reconnect replay of
// the same event use one device identity and one durable receipt.
((scope)=>{
  const dbName='attnwall-remote-sync',leaseMs=30000;
  let opening,temporaryId;
  const localReceipts=new Map();
  function uniqueId(){
    if(scope.crypto?.randomUUID)return scope.crypto.randomUUID();
    if(scope.crypto?.getRandomValues){const bytes=new Uint8Array(16);scope.crypto.getRandomValues(bytes);return [...bytes].map(v=>v.toString(16).padStart(2,'0')).join('');}
    return 'remote-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)+'-'+Math.random().toString(36).slice(2);
  }
  function open(){
    if(opening)return opening;
    opening=new Promise((resolve,reject)=>{
      if(!scope.indexedDB)return reject(new Error('IndexedDB unavailable'));
      const request=scope.indexedDB.open(dbName,1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains('meta'))db.createObjectStore('meta');
        if(!db.objectStoreNames.contains('receipts'))db.createObjectStore('receipts');
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error||new Error('IndexedDB unavailable'));
      request.onblocked=()=>reject(new Error('IndexedDB blocked'));
    });
    return opening;
  }
  async function transaction(store,work){
    const db=await open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(store,'readwrite'),items=tx.objectStore(store);
      let result;
      work(items,value=>{result=value;});
      tx.oncomplete=()=>resolve(result);
      tx.onerror=()=>reject(tx.error||new Error('Receipt storage failed'));
      tx.onabort=()=>reject(tx.error||new Error('Receipt storage aborted'));
    });
  }
  async function deviceId(){
    try{return await transaction('meta',(items,done)=>{
      const request=items.get('deviceId');
      request.onsuccess=()=>{const id=request.result||uniqueId();if(!request.result)items.put(id,'deviceId');done(id);};
    });}catch{
      try{
        const key='attnwall-remote-device-id';let id=scope.localStorage?.getItem(key);
        if(!id){id=uniqueId();scope.localStorage?.setItem(key,id);}
        if(scope.localStorage)return id;
      }catch{}
      return temporaryId||(temporaryId=uniqueId());
    }
  }
  async function claim(id,owner){
    const now=Date.now();
    try{return await transaction('receipts',(items,done)=>{
      const request=items.get(id);
      request.onsuccess=()=>{
        const row=request.result;
        if(row?.state==='done'){done('done');return;}
        if(row?.state==='processing'&&row.expiresAt>now){done('busy');return;}
        items.put({state:'processing',owner,expiresAt:now+leaseMs},id);done('claimed');
      };
    });}catch{
      const row=localReceipts.get(id);
      if(row?.state==='done')return 'done';
      if(row?.state==='processing'&&row.expiresAt>now)return 'busy';
      localReceipts.set(id,{state:'processing',owner,expiresAt:now+leaseMs});return 'claimed';
    }
  }
  async function finish(id,owner,success){
    try{await transaction('receipts',(items,done)=>{
      const request=items.get(id);
      request.onsuccess=()=>{
        if(request.result?.owner===owner){if(success)items.put({state:'done'},id);else items.delete(id);}
        done();
      };
    });}catch{
      if(localReceipts.get(id)?.owner===owner){if(success)localReceipts.set(id,{state:'done'});else localReceipts.delete(id);}
    }
  }
  async function process(notice,display){
    if(!notice?.notificationId){await display();return 'done';}
    const id=String(notice.notificationId),owner=uniqueId(),status=await claim(id,owner);
    if(status!=='claimed')return status;
    try{await display();await finish(id,owner,true);return 'done';}
    catch(error){await finish(id,owner,false);throw error;}
  }
  async function acknowledge(ids){
    if(!ids.length)return;
    const response=await scope.fetch('/api/remote/ack',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:await deviceId(),ids})});
    if(!response.ok)throw new Error('Remote acknowledgment failed: HTTP '+response.status);
  }
  scope.AttnWallReceipts={deviceId,process,acknowledge};
})(globalThis);
