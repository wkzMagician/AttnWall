// Synchronize a PWA icon badge without blocking the inbox on unsupported platforms.
export function createBadgeSynchronizer(platform){
  let lastCount=null,sequence=Promise.resolve();
  return function syncAppBadge(count){
    if(!Number.isSafeInteger(count)||count<0||typeof platform?.setAppBadge!=='function')return sequence;
    // Serialize updates: a stale in-flight call cannot overwrite the newest count.
    sequence=sequence.then(async()=>{
      if(lastCount===count)return;
      if(count===0&&typeof platform.clearAppBadge==='function')await platform.clearAppBadge();
      else await platform.setAppBadge(count);
      lastCount=count;
    }).catch(()=>{/* Ignore denied/unsupported Badging API, and retry on later state changes. */});
    return sequence;
  };
}
