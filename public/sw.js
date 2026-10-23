self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
  let payload={title:'AttnWall',body:'收到 Agent 消息',kind:'batch'};
  try{payload={...payload,...event.data.json()};}catch{}
  const opts={body:payload.body||'',icon:'/icon.svg',badge:'/icon.svg',tag:payload.kind==='batch'?'attnwall-batch':undefined,
    data:{url:payload.sessionId?'/?session='+encodeURIComponent(payload.sessionId):'/'}};
  event.waitUntil(self.registration.showNotification(payload.title,opts));
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
