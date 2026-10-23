import {createBadgeSynchronizer} from './app-badge.js';
const $=(id)=>document.getElementById(id);
const state={sessions:[],inbox:[],unreadCount:0,settings:{},selected:null,view:'inbox',historyData:null,historyRequested:new Set(),instantOverride:new Map(),pushDevices:[],pushReport:null,nextBatchAt:null,queuedNormal:0,pushSubscribed:false,refreshing:false};
const escapeHtml=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const esc=escapeHtml;
const when=(ts)=>new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',month:'2-digit',day:'2-digit'}).format(new Date(ts));
const humanTime=(ts)=>new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit'}).format(new Date(ts));
let toastTimer,refreshTimer,sse;
// Only the released unread total is ever passed to the OS badge.
const syncAppBadge=createBadgeSynchronizer(navigator);

function toast(text){$('toast').textContent=text;$('toast').classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),3200);}
async function api(method,path,data){
  const resp=await fetch(path,{method,headers:{'Content-Type':'application/json'},credentials:'same-origin',body:data===undefined?undefined:JSON.stringify(data)});
  const result=await resp.json().catch(()=>({error:'服务器返回格式错误'}));
  if(resp.status===401){showLogin();throw new Error('需要重新登录');}
  if(!resp.ok)throw new Error(result.error||('HTTP '+resp.status));
  return result;
}
function showLogin(){
  $('login').classList.remove('hidden');$('application').classList.add('hidden');
  if(sse){sse.close();sse=null;}
}
function showApplication(){$('login').classList.add('hidden');$('application').classList.remove('hidden');}
function setConnected(ok){$('connection-dot').classList.toggle('offline',!ok);$('connection-label').textContent=ok?'消息中心已连接':'连接已中断';}
function dndNow(cfg){
  if(!cfg.dndEnabled||cfg.dndStart===cfg.dndEnd)return false;
  let time;
  try{time=new Intl.DateTimeFormat('en-GB',{timeZone:cfg.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());}
  catch{return false;}
  const mins=x=>Number(x.slice(0,2))*60+Number(x.slice(3,5));
  const n=mins(time),a=mins(cfg.dndStart),b=mins(cfg.dndEnd);
  return a<b?n>=a&&n<b:n>=a||n<b;
}
function refreshClock(){
  const dnd=dndNow(state.settings),due=state.nextBatchAt;
  const idle=!due;
  $('delivery-text').textContent=idle?(dnd?'免打扰中 · 暂无待通知消息':'保持专注 · 暂无待通知消息'):
    dnd?'免打扰生效中 · '+state.settings.dndEnd+' 后恢复提醒':'下次批量提醒 · '+humanTime(due);
  $('delivery-subtitle').textContent=idle?'首条新消息到来后，开始 '+state.settings.intervalMin+' 分钟倒计时。Instant 立即提醒。':
    dnd?'普通消息静默累计，免打扰结束后投递 · Instant 例外':'从首条待通知消息开始计时 · Instant 立即通知';
  $('dnd-tag').textContent=dnd?'免打扰中':idle?'等待新消息':'批量通知';
}
function sessionNode(s){
  return '<button class="session-entry'+(state.selected===s.id&&state.view==='conversation'?' active':'')+'" data-session="'+esc(s.id)+'">'+
  '<span class="runtime-square '+esc(s.runtime)+'">'+esc(({codex:'CX',dsh:'DS','codex-web':'CW','deepseek-web':'DW','chatgpt-web':'CG'})[s.runtime]||'AI')+'</span><span class="session-info"><strong>'+esc(s.title)+'</strong>'+
  '<small>'+esc(s.host)+' · '+esc(s.runtime.toUpperCase())+(s.status==='active'?' · 工作中':s.status==='error'?' · 执行失败':s.status==='incompatible'?' · CLI 版本不兼容':'')+'</small></span>'+(s.unread?'<span class="counter">'+s.unread+'</span>':'')+'</button>';
}
const SESSION_RANGES={ '1d':24*60*60*1000,'7d':7*24*60*60*1000,'30d':30*24*60*60*1000,all:Infinity };
function restoredSessionRange(){
  try{const value=localStorage.getItem('attnwall.sessionRange');if(value in SESSION_RANGES)return value;}catch{}
  return '7d';
}
function sessionRangeMatches(s,now=Date.now()){
  return state.sessionRange==='all'||(Number(s.activity_at)>0 && Number(s.activity_at)>=now-SESSION_RANGES[state.sessionRange]);
}
function visibleSessions(){
  const search=($('session-search')?.value||'').trim().toLowerCase();
  const matching=state.sessions.filter(s=>search?
    (s.title+' '+s.runtime+' '+s.host+' '+s.native_id).toLowerCase().includes(search):sessionRangeMatches(s));
  const pinned=state.view==='conversation'&&state.selected?
    state.sessions.find(s=>s.id===state.selected&&!sessionRangeMatches(s)):null;
  return {matching,visible:pinned?[pinned,...matching]:matching,pinned:!!pinned};
}
function groupedInbox(){
  const groups=new Map();
  for(const message of state.inbox){
    if(!groups.has(message.session_id))groups.set(message.session_id,{latest:message,messages:[]});
    groups.get(message.session_id).messages.push(message);
  }
  return [...groups.values()].map(group=>{
    group.unread=state.sessions.find(s=>s.id===group.latest.session_id)?.unread||group.messages.length;
    return group;
  });
}
function inboxGroupCard(group){
  const m=group.latest,approval=group.messages.find(x=>x.kind==='approval');
  const count=group.unread;
  const preview=group.messages.slice(0,2).map(x=>
    '<div class="inbox-preview">'+esc(x.body)+'</div>').join('');
  const buttons=approval?
    '<div class="approval-actions"><button class="primary" data-approval="'+esc(approval.id)+'" data-decision="accept">批准</button>'+
    '<button class="outline" data-approval="'+esc(approval.id)+'" data-decision="decline">拒绝</button></div>':'';
  return '<article class="inbox-card" tabindex="0" role="button" data-session="'+esc(m.session_id)+'">'+
    '<div class="inbox-top"><span class="runtime-tag '+esc(m.runtime)+'">'+esc(m.runtime)+'</span>'+
    '<strong>'+esc(m.title)+'</strong>'+(m.priority==='instant'?'<span class="priority">INSTANT</span>':'')+
    '<span class="date-text">'+esc(when(m.created_at))+'</span></div>'+
    (count>1?'<div class="inbox-group-count">'+count+' 条未读消息 · 点击查看完整会话</div>':'')+
    preview+buttons+'</article>';
}
function render(){
  const {matching,visible,pinned}=visibleSessions();
  $('stat-sessions').textContent=matching.length;
  const label=$('session-range').selectedOptions[0]?.textContent||'最近一周';
  $('stat-session-range').textContent=label+' · 所有已连接平台';
  $('session-filter-summary').textContent='显示 '+matching.length+' / '+state.sessions.length+' 个会话'+(pinned?' · 当前会话额外显示':'');
  $('stat-unread').textContent=state.unreadCount;
  $('stat-queue').textContent=state.queuedNormal;
  $('session-count').textContent=matching.length;
  $('unread-count').textContent=state.unreadCount;
  void syncAppBadge(state.unreadCount);
  $('inbox-window').textContent=state.unreadCount>state.inbox.length?'(显示最近 '+state.inbox.length+' 条)':'';
  $('session-list').innerHTML=visible.length?visible.map(sessionNode).join(''):
    '<div class="subtle" style="padding:12px">此时间范围内没有活跃会话。你可以调整筛选范围查看更早的会话。</div>';
  if(state.view==='inbox')$('inbox-items').innerHTML=state.inbox.length?
    groupedInbox().map(inboxGroupCard).join(''):
    '<div class="empty"><div class="empty-symbol">✦</div><strong>'+(state.queuedNormal?'消息正在静默累计':'收件箱清空了')+'</strong><span>'+(state.queuedNormal?'普通消息将在允许投递的时间统一显示；Instant 可立即呈现。':'没有待处理的消息。Agent 可以继续工作，你可以继续专注。')+'</span></div>';  refreshClock();
  $('inbox-view').classList.toggle('hidden',state.view!=='inbox');
  $('conversation-view').classList.toggle('hidden',state.view!=='conversation');
  $('settings-view').classList.toggle('hidden',state.view!=='settings');
  $('inbox-nav').classList.toggle('active',state.view==='inbox');
  document.querySelectorAll('.mobile-nav button').forEach(b=>b.classList.toggle('active',b.dataset.nav===(state.view==='conversation'?'sessions':state.view)));
  if(state.view==='settings'){renderSettings();renderPushDevices();}
}
async function loadState(){
  if(state.refreshing)return;
  state.refreshing=true;
  try{
    const p=await api('GET','/api/state');
    for(const session of p.sessions){
      if(!state.instantOverride.has(session.id))continue;
      const pending=state.instantOverride.get(session.id);
      if(Boolean(session.instant_mode)===Boolean(pending))state.instantOverride.delete(session.id);
      else session.instant_mode=pending;
    }
    Object.assign(state,{sessions:p.sessions,inbox:p.inbox,unreadCount:p.unreadCount??p.inbox.length,settings:p.settings,nextBatchAt:p.nextBatchAt,queuedNormal:p.queuedNormal,pushDevices:p.pushDevices||[],pushReport:p.pushReport||null});
    setConnected(true);showApplication();render();
    if(state.view==='conversation'&&state.selected)await loadConversation();
  }finally{state.refreshing=false;}
}
function requestRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>loadState().catch(e=>{setConnected(false);console.error(e);}),200);}
function connectEvents(){
  if(sse)sse.close();
  sse=new EventSource('/api/events');
  sse.addEventListener('update',requestRefresh);
  sse.addEventListener('notification',e=>{
    const n=JSON.parse(e.data);
    if(!state.pushSubscribed && typeof Notification!=='undefined'&&Notification.permission==='granted'){
      const notice=new Notification(n.title,{body:n.body,tag:n.kind==='batch'?'attnwall-batch':undefined,icon:'/icon.svg'});
      notice.onclick=()=>{window.focus();if(n.sessionId)openSession(n.sessionId);notice.close();};
    }
    requestRefresh();
  });
  sse.onopen=()=>setConnected(true);
  sse.onerror=()=>setConnected(false);
}
function navigate(view,{keepUrl=false}={}){
  $('application').classList.remove('show-sessions');
  state.view=view;render();
  if(!keepUrl&&view!=='conversation'&&location.search)history.pushState({},'',location.pathname);
  if(view==='conversation')loadConversation().catch(e=>toast(e.message));
}
function openSession(id,{keepUrl=false}={}){
  if(!state.sessions.some(s=>s.id===id)){toast('会话尚未连接');return;}
  if(state.selected!==id){
    state.historyData=null;
    // Never carry an unsent message or private attachment into another conversation.
    $('compose-text').value='';$('compose-image').value='';renderSelectedAttachment();
  }
  state.selected=id;
  if(!keepUrl)history.pushState({},'','/?session='+encodeURIComponent(id));
  navigate('conversation',{keepUrl:true});
}
function renderConversation(s){
  const data=state.historyData;if(!data||data.id!==s.id)return;
  const items=[...data.messages.map(m=>({body:m.body,ts:m.created_at,role:m.role,priority:m.priority,kind:m.kind,id:m.id})),
    ...(data.replies||[]).filter(r=>r.state!=='sent').map(r=>({body:r.text,ts:r.created_at,role:'user',pending:r.state,error:r.error,id:r.id}))]
    .sort((a,b)=>a.ts-b.ts||(a.id||'').localeCompare(b.id||''));
  const el=$('conversation-messages'),nearBottom=el.scrollHeight-el.scrollTop-el.clientHeight<90;
  el.innerHTML=items.length?items.map(m=>
    '<div class="message '+(m.role==='user'?'mine':'')+'"><div class="message-meta">'+esc(m.role==='user'?'你':s.runtime.toUpperCase())+' · '+esc(when(m.ts))+
    (m.priority==='instant'?' · Instant':'')+(m.pending?' · '+esc(m.pending):'')+'</div><div class="bubble">'+esc(m.body)+'</div>'+
    (m.pending==='failed'?'<button class="text-button retry-button" data-retry="'+esc(m.id)+'">重试 · '+esc(m.error||'未送达')+'</button>':'')+'</div>'
  ).join(''):'<div class="empty"><strong>暂无本地消息</strong><span>正在尝试读取原始会话历史，你也可以直接回复。</span></div>';
  if(nearBottom)el.scrollTop=el.scrollHeight;
  $('history-older').classList.toggle('hidden',!data.hasMore);
  const h=data.history;
  $('history-status').textContent=s.runtime==='dsh'?
    'DSH SDK 不支持读取外部历史；这里显示 AttnWall 已采集的消息。':
    s.runtime!=='codex'&&s.runtime!=='chatgpt-web'&&s.runtime!=='codex-web'&&s.runtime!=='deepseek-web'?'暂无可读取的完整历史。':
    h?.state==='complete'?'最近消息已同步（每次最多 5 条） · 当前显示 '+data.messages.length+' 条':
    h?.state==='error'?'同步失败：'+(h.error||'未知错误'):
    '正在读取最近少量消息（最多 5 条）…';
  $('history-retry').classList.toggle('hidden',!['codex','chatgpt-web','codex-web','deepseek-web'].includes(s.runtime)||h?.state!=='error');
}
function isWebSession(s){return ['chatgpt-web','codex-web','deepseek-web'].includes(s?.runtime);}
function renderSelectedAttachment(){
  const input=$('compose-image'),file=input.files?.[0],preview=$('compose-attachment-preview');
  preview.classList.toggle('hidden',!file);
  if(file){
    preview.textContent='图片：'+file.name+'（'+Math.ceil(file.size/1024)+' KB）';
    const clear=document.createElement('button');
    clear.type='button';clear.textContent='移除';clear.className='text-button';
    clear.onclick=()=>{input.value='';renderSelectedAttachment();};
    preview.append(clear);
  }else preview.textContent='';
}
function fileToBase64(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error('无法读取选择的图片'));
    reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');
    reader.readAsDataURL(file);
  });
}
function updateInstantControl(enabled){
  const button=$('instant-toggle');
  button.textContent=enabled?'⚡ 快速模式：开':'⚡ 快速模式：关';
  button.classList.toggle('instant-active',enabled);
  button.setAttribute('aria-pressed',String(enabled));
  button.setAttribute('aria-label',enabled?'关闭快速模式':'开启快速模式');
  $('reply-hint').textContent=enabled?'快速模式已开启：后续 Agent 消息立即提醒。':'消息立即发送；后续通知仍遵循你的提醒间隔。';
}
async function loadConversation(){
  const id=state.selected;if(!id)return;
  const s=state.sessions.find(x=>x.id===id);if(!s)return;
  updateInstantControl(!!s.instant_mode);
  $('conversation-name').textContent=s.title;
  $('conversation-runtime').textContent=s.runtime.toUpperCase()+' · '+s.host+' · '+s.status;
  $('conversation-path').textContent=s.source_url||s.cwd||'原始会话 '+s.native_id;
  $('compose-image-label').classList.toggle('hidden',!isWebSession(s));
  const result=await api('GET','/api/messages?sessionId='+encodeURIComponent(id)+'&limit=5');
  if(id!==state.selected)return;
  let data=state.historyData;
  if(!data||data.id!==id){data={id,messages:[],replies:[],windowSize:5,hasMore:result.hasMore,history:null};state.historyData=data;}
  const merged=new Map([...data.messages,...result.messages].map(m=>[m.id,m]));
  data.messages=[...merged.values()].sort((a,b)=>a.created_at-b.created_at||a.id.localeCompare(b.id)).slice(-(data.windowSize||5));
  if(data.messages.length===result.messages.length)data.hasMore=result.hasMore;
  data.replies=result.replies;
  data.history=result.history;
  renderConversation(s);
  if(['codex','chatgpt-web','codex-web','deepseek-web'].includes(s.runtime)&&!state.historyRequested.has(id)){
    state.historyRequested.add(id);
    try{
      const requested=await api('POST','/api/sessions/history',{sessionId:id});
      if(id===state.selected){data.history=requested.history;renderConversation(s);}
    }catch(e){state.historyRequested.delete(id);toast('历史同步失败：'+e.message);}
  }
}
async function loadOlder(){
  const data=state.historyData,first=data?.messages[0];
  if(!data||!first||!data.hasMore)return;
  const button=$('history-older');button.disabled=true;
  const el=$('conversation-messages'),height=el.scrollHeight,top=el.scrollTop;
  try{
    const query='?sessionId='+encodeURIComponent(data.id)+'&limit=5&beforeTime='+encodeURIComponent(first.created_at)+'&beforeId='+encodeURIComponent(first.id);
    const page=await api('GET','/api/messages'+query);
    if(data.id!==state.selected)return;
    const merged=new Map([...page.messages,...data.messages].map(m=>[m.id,m]));
    data.messages=[...merged.values()].sort((a,b)=>a.created_at-b.created_at||a.id.localeCompare(b.id));
    data.windowSize=data.messages.length;
    data.hasMore=page.hasMore;
    const s=state.sessions.find(x=>x.id===data.id);if(s)renderConversation(s);
    el.scrollTop=el.scrollHeight-height+top;
  }catch(e){toast(e.message);}
  finally{button.disabled=false;}
}
async function markRead(sessionId){
  const result=await api('POST','/api/messages/read-all',sessionId?{sessionId}:{});
  await loadState();toast(result.updated?'已标记 '+result.updated+' 条消息':'没有未读消息');
}
function renderPushDevices(){
  const devices=state.pushDevices||[];
  const report=state.pushReport;
  $('push-device-list').innerHTML=devices.length?devices.map(d=>{
    const last=report?.results?.find(r=>r.id===d.id);
    const result=last?last.accepted?
      '推送服务已接受 · HTTP '+esc(last.code):
      '发送失败 · '+esc(last.code||'网络错误')+' · '+esc(last.reason||''):
      '尚无本次服务运行中的投递结果';
    return '<div class="push-device-row"><div><strong>'+esc(d.name||'浏览器设备')+'</strong>'+
      '<small>'+esc(d.provider)+' · '+result+'</small></div>'+
      '<button class="outline" type="button" data-push-test="'+esc(d.id)+'">测试此设备</button></div>';
  }).join(''):'<div class="muted">暂无订阅设备。请在 iPhone 主屏幕 Web App 中点击右上角的通知按钮并授权。</div>';
}
function renderSettings(){
  if(document.activeElement?.closest('#settings-form'))return;
  const s=state.settings;
  $('interval').value=s.intervalMin;$('dnd-enabled').checked=s.dndEnabled;
  $('dnd-start').value=s.dndStart;$('dnd-end').value=s.dndEnd;
  $('time-zone').value=s.timeZone;$('instant-enabled').checked=s.instantEnabled;
}
function vapidBytes(s){
  const base=(s+'='.repeat((4-s.length%4)%4)).replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(base);return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
async function activatePush(){
  if(!('serviceWorker'in navigator)||!('PushManager'in window)||!('Notification'in window))throw new Error('本浏览器不支持 Web Push');
  if(Notification.permission==='denied')throw new Error('系统已禁止通知，请在浏览器设置中开启');
  const reg=await navigator.serviceWorker.register('/sw.js',{scope:'/'});
  const granted=await Notification.requestPermission();if(granted!=='granted')throw new Error('通知未授权');
  let sub=await reg.pushManager.getSubscription();
  if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:vapidBytes((await api('GET','/api/state')).pushPublicKey)});
  await api('POST','/api/push',{subscription:sub.toJSON(),name:navigator.platform||'Browser'});
  state.pushSubscribed=true;await syncAppBadge(state.unreadCount);toast('设备通知已启用');
}
async function detectPush(){
  try{if('serviceWorker'in navigator){
    const reg=await navigator.serviceWorker.getRegistration('/');
    state.pushSubscribed=!!(reg&&await reg.pushManager?.getSubscription());
  }}catch{}
}
$('login-form').addEventListener('submit',async e=>{
  e.preventDefault();$('login-error').textContent='';
  try{
    const response=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:$('access-token').value})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'登录失败');
    $('access-token').value='';await loadState();connectEvents();
    const requested=new URLSearchParams(location.search).get('session');
    if(requested)openSession(requested,{keepUrl:true});
  }catch(err){$('login-error').textContent=err.message;}
});
$('inbox-nav').addEventListener('click',()=>navigate('inbox'));
$('session-list').addEventListener('click',e=>{const b=e.target.closest('[data-session]');if(b)openSession(b.dataset.session);});
$('session-search').addEventListener('input',()=>render());
$('session-range').addEventListener('change',e=>{
  const value=e.target.value;
  if(!(value in SESSION_RANGES))return;
  state.sessionRange=value;
  try{localStorage.setItem('attnwall.sessionRange',value);}catch{}
  render();
});
$('inbox-items').addEventListener('click',async e=>{
  const button=e.target.closest('[data-approval]');if(!button)return;
  e.stopPropagation();button.disabled=true;
  try{await api('POST','/api/approvals',{messageId:button.dataset.approval,decision:button.dataset.decision});toast('审批决定已入发送队列');await loadState();}
  catch(err){toast(err.message);}finally{button.disabled=false;}
});
$('inbox-items').addEventListener('click',e=>{if(e.target.closest('[data-approval]'))return;const b=e.target.closest('[data-session]');if(b)openSession(b.dataset.session);});
$('inbox-items').addEventListener('keydown',e=>{if(e.key==='Enter'){const b=e.target.closest('[data-session]');if(b)openSession(b.dataset.session);}});
$('mark-all').addEventListener('click',()=>markRead().catch(e=>toast(e.message)));
$('instant-toggle').addEventListener('click',async()=>{
  const s=state.sessions.find(x=>x.id===state.selected);if(!s)return;
  const enabled=!s.instant_mode;
  try{
    const result=await api('POST','/api/sessions/instant',{sessionId:s.id,enabled});
    Object.assign(s,result.session);
    state.instantOverride.set(s.id,enabled?1:0);
    updateInstantControl(enabled);
    toast(enabled?'即时对话已开启':'即时对话已关闭');
    requestRefresh();
  }catch(e){toast(e.message);}
});
$('mark-session-read').addEventListener('click',()=>markRead(state.selected).catch(e=>toast(e.message)));
$('history-older').addEventListener('click',()=>loadOlder());
$('history-retry').addEventListener('click',async()=>{
  const id=state.selected;if(!id)return;
  try{
    state.historyRequested.add(id);
    const res=await api('POST','/api/sessions/history',{sessionId:id,force:true});
    if(state.historyData?.id===id)state.historyData.history=res.history;
    await loadConversation();
  }catch(e){toast(e.message);}
});
$('back-button').addEventListener('click',()=>navigate('inbox'));
$('settings-button').addEventListener('click',()=>navigate('settings'));
document.querySelector('.mobile-nav').addEventListener('click',e=>{
  const b=e.target.closest('[data-nav]');if(!b)return;
  if(b.dataset.nav==='sessions'){$('application').classList.add('show-sessions');document.querySelectorAll('.mobile-nav button').forEach(x=>x.classList.toggle('active',x===b));}
  else navigate(b.dataset.nav);
});
$('compose-image').addEventListener('change',()=>{
  const file=$('compose-image').files?.[0];
  if(file&&(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>3000000)){
    $('compose-image').value='';toast('请选择小于 3MB 的 PNG、JPG 或 WebP 图片');
  }
  renderSelectedAttachment();
});
$('compose').addEventListener('submit',async e=>{
  e.preventDefault();const text=$('compose-text').value.trim(),file=$('compose-image').files?.[0];
  if(!text&&!file)return;
  const button=e.submitter;button.disabled=true;
  try{
    const id=crypto.randomUUID(),sessionId=state.selected;
    if(file){
      const session=state.sessions.find(s=>s.id===sessionId);
      if(!isWebSession(session))throw new Error('图片附件目前仅支持网页会话');
      if(file.size>3000000)throw new Error('图片不得超过 3MB');
      const data=await fileToBase64(file);
      await api('POST','/api/replies/image',{sessionId,text,id,image:{data,type:file.type,name:file.name}});
    }else await api('POST','/api/replies',{sessionId,text,id});
    $('compose-text').value='';$('compose-image').value='';renderSelectedAttachment();
    toast('已加入发送队列；请以原网页投递结果为准');await loadConversation();
  }catch(err){toast(err.message);}
  finally{button.disabled=false;}
});
$('conversation-messages').addEventListener('click',async e=>{
  const button=e.target.closest('[data-retry]');if(!button)return;
  try{await api('POST','/api/replies/retry',{id:button.dataset.retry});toast('重新加入发送队列');await loadConversation();}
  catch(err){toast(err.message);}
});
$('settings-form').addEventListener('submit',async e=>{
  e.preventDefault();try{
    const settings={intervalMin:Number($('interval').value),dndEnabled:$('dnd-enabled').checked,
      dndStart:$('dnd-start').value,dndEnd:$('dnd-end').value,timeZone:$('time-zone').value.trim(),
      instantEnabled:$('instant-enabled').checked};
    await api('POST','/api/settings',settings);$('settings-feedback').textContent='已保存';toast('提醒规则已更新');await loadState();
  }catch(err){$('settings-feedback').textContent=err.message;}
});
$('copy-browser-config').addEventListener('click',async()=>{
  const out=$('browser-config-feedback');
  try{
    const setup=await api('GET','/api/browser/setup');
    const data=JSON.stringify({kind:'attnwall-browser-v1',hub:location.origin,browserToken:setup.browserToken});
    await navigator.clipboard.writeText(data);
    out.textContent='连接配置已复制。请粘贴到浏览器扩展弹窗中。';
    toast('已复制浏览器扩展连接配置');
  }catch(e){out.textContent='复制失败：'+e.message+'。请通过 HTTPS 或 localhost 打开 AttnWall。';}
});
$('push-device-list').addEventListener('click',async e=>{
  const b=e.target.closest('[data-push-test]');if(!b)return;
  b.disabled=true;
  $('push-test-feedback').textContent='正在联系推送服务…';
  try{
    const r=await api('POST','/api/push/test',{deviceId:b.dataset.pushTest});
    const item=r.report.results[0];
    $('push-test-feedback').textContent=item?.accepted?
      '推送服务已接受 (HTTP '+item.code+')。请查看该设备的锁屏或通知中心。':
      '推送失败：HTTP '+(item?.code||'未知')+' · '+(item?.reason||'网络问题');
    await loadState();
  }catch(err){$('push-test-feedback').textContent=err.message;}
  finally{b.disabled=false;}
});
$('notify-button').addEventListener('click',()=>activatePush().catch(e=>toast(e.message)));
$('logout').addEventListener('click',async()=>{await api('POST','/api/logout');void syncAppBadge(0);showLogin();});
$('attach-button').addEventListener('click',()=>$('add-source-dialog').showModal());
$('add-source-cancel').addEventListener('click',()=>$('add-source-dialog').close());
$('add-source-dialog').addEventListener('click',e=>{
  const source=e.target.closest('[data-add-source]')?.dataset.addSource;
  if(!source)return;
  $('add-source-dialog').close();
  if(source==='dsh')$('attach-dialog').showModal();
  else if(source==='web'){
    navigate('settings');
    document.querySelector('.browser-onboarding')?.scrollIntoView({block:'start',behavior:'smooth'});
  }else if(source==='codex'){
    toast('Codex CLI 会话由本机 Connector 自动发现；请检查桌面连接器状态。');
  }
});
$('attach-cancel').addEventListener('click',()=>$('attach-dialog').close());
$('attach-form').addEventListener('submit',async e=>{
  e.preventDefault();const id=$('new-dsh-id').value.trim(),host=$('new-dsh-host').value.trim(),title=$('new-dsh-title').value.trim();
  try{
    const result=await api('POST',id?'/api/sessions/attach':'/api/sessions/new-dsh',{runtime:'dsh',host,nativeId:id,title});
    $('attach-dialog').close();await loadState();openSession(result.id);toast('DSH 会话已添加');
  }catch(err){toast(err.message);}
});
state.sessionRange=restoredSessionRange();
$('session-range').value=state.sessionRange;
setInterval(refreshClock,15000);
detectPush();
window.addEventListener('popstate',()=>{
  const requested=new URLSearchParams(location.search).get('session');
  if(requested)openSession(requested,{keepUrl:true});
  else navigate('inbox',{keepUrl:true});
});
loadState().then(()=>{
  connectEvents();
  const requested=new URLSearchParams(location.search).get('session');
  if(requested&&state.sessions.some(s=>s.id===requested))openSession(requested,{keepUrl:true});
}).catch(()=>showLogin());
