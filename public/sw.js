self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
  let payload={title:'AttnWall',body:(self.navigator?.language||'').toLowerCase().startsWith('zh')?'收到 Agent 消息':'New agent message',kind:'batch'};
  try{payload={...payload,...event.data.json()};}catch{}
  const opts={body:payload.body||'',icon:'/icons/attnwall-coral-v1-192.png',badge:'/icon.svg',tag:payload.notificationId?'attnwall:'+payload.notificationId:payload.kind==='batch'?'attnwall-batch':undefined,
    data:{url:payload.sessionId?'/?session='+encodeURIComponent(payload.sessionId):'/'}};
  // A numeric icon badge is separate from NotificationOptions.badge (an image).
  // Do not change the badge for diagnostic test pushes or legacy payloads.
  const count=payload.unreadCount;
  const badgeTask=(Number.isSafeInteger(count)&&count>=0&&typeof self.navigator?.setAppBadge==='function')
    ? Promise.resolve().then(()=>count===0&&typeof self.navigator.clearAppBadge==='function'
      ? self.navigator.clearAppBadge():self.navigator.setAppBadge(count)).catch(()=>{})
    : Promise.resolve();
  event.waitUntil(Promise.all([self.registration.showNotification(payload.title,opts),badgeTask]));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const url=new URL(event.notification.data?.url||'/',self.location.origin);
  event.waitUntil((async()=>{
    for(const client of await self.clients.matchAll({type:'window',includeUncontrolled:true})){
      if(new URL(client.url).origin===url.origin){await client.navigate(url.href);return client.focus();}
    }
    return self.clients.openWindow(url.href);
  })());
});
