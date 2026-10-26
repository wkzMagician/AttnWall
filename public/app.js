import {createBadgeSynchronizer} from './app-badge.js';
import {i18n} from './i18n.js';
const $=(id)=>document.getElementById(id);
const state={sessions:[],inbox:[],unreadCount:0,settings:{},selected:null,view:'inbox',historyData:null,historyRequested:new Set(),instantOverride:new Map(),pushDevices:[],pushReport:null,nextBatchAt:null,queuedNormal:0,pushSubscribed:false,refreshing:false,sendingReply:false};
let localeSynced=false;
const escapeHtml=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const esc=escapeHtml;
const when=(ts)=>new Intl.DateTimeFormat(i18n.getLocale(),{hour:'2-digit',minute:'2-digit',month:'2-digit',day:'2-digit'}).format(new Date(ts));
const humanTime=(ts)=>new Intl.DateTimeFormat(i18n.getLocale(),{hour:'2-digit',minute:'2-digit'}).format(new Date(ts));
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
function setConnected(ok){$('connection-label').textContent=ok?'':'连接中断';$('connection-label').classList.toggle('hidden',ok);}
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
  const pending=state.nextBatchAt!==null;
  $('delivery-status').classList.toggle('hidden',!pending);
  $('stat-queue').textContent=state.queuedNormal;
  $('delivery-text').textContent=dndNow(state.settings)?'免打扰至 '+state.settings.dndEnd:state.nextBatchAt?(state.queuedNormal===0&&Date.now()>=state.nextBatchAt?'计时已到，等待任务完成':'提醒时间 '+humanTime(state.nextBatchAt)):'';
}

function sessionNode(s){
  const provider=({codex:['codex','Codex'],'codex-web':['codex','Codex'],dsh:['deepseek','DeepSeek'],'deepseek-web':['deepseek','DeepSeek'],'chatgpt-web':['chatgpt','ChatGPT']})[s.runtime];
  const icon=provider?'<img class="runtime-logo" src="/icons/'+provider[0]+'.svg" alt="" width="22" height="22">':'<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5z M8 9l3 3-3 3 M13 15h3"/></svg>';
  return '<button title="'+esc(s.host+' · '+s.runtime)+'" class="session-entry'+(state.selected===s.id&&state.view==='conversation'?' active':'')+'" data-session="'+esc(s.id)+'">'+
  '<span class="runtime-square '+esc(s.runtime)+'" aria-hidden="true" title="'+(provider?provider[1]:'Agent')+'">'+icon+'</span><span class="session-info"><strong data-i18n-skip>'+esc(s.title)+'</strong>'+
  '<small>'+esc(provider?provider[1]:s.runtime)+(s.host!=='local'&&!s.host.startsWith('web-')?' · '+esc(s.host.slice(0,24)):'')+(s.status==='active'?' · 工作中':s.status==='error'?' · 执行失败':s.status==='incompatible'?' · CLI 版本不兼容':'')+'</small></span>'+(s.unread?'<span class="counter">'+s.unread+'</span>':'')+'</button>';
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
  const pinned=!search&&state.view==='conversation'&&state.selected?
    state.sessions.find(s=>s.id===state.selected&&!matching.some(item=>item.id===s.id)):null;
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
  const preview='<div class="inbox-preview" data-i18n-skip>'+esc(m.body)+'</div>';
  const buttons=approval?
    '<div class="approval-actions"><button class="primary" data-approval="'+esc(approval.id)+'" data-decision="accept">批准</button>'+
    '<button class="outline" data-approval="'+esc(approval.id)+'" data-decision="decline">拒绝</button></div>':'';
  return '<article class="inbox-card" tabindex="0" role="button" data-session="'+esc(m.session_id)+'">'+
    '<div class="inbox-top"><span class="runtime-tag '+esc(m.runtime)+'">'+esc(m.runtime)+'</span>'+
    '<strong data-i18n-skip>'+esc(m.title)+'</strong>'+
    '<span class="date-text">'+esc(when(m.created_at))+'</span></div>'+
    (count>1?'<div class="inbox-group-count">'+count+' 条未读</div>':'')+
    preview+buttons+'</article>';
}
function renderNotifyButton(){
  const enabled=state.pushSubscribed;
  const button=$('notify-button');
  button.setAttribute('aria-pressed',String(enabled));
  button.title=enabled?'通知已启用':'启用通知';
  button.setAttribute('aria-label',button.title);
}
function render(){
  const {matching,visible,pinned}=visibleSessions();
  $('session-filter-summary').textContent=matching.length+' / '+state.sessions.length;
  $('session-filter-summary').title=pinned?'当前会话额外显示':'';
  $('mark-all').classList.toggle('hidden',!state.unreadCount);
  $('unread-count').textContent=state.unreadCount;
  void syncAppBadge(state.unreadCount);renderNotifyButton();
  $('unread-count').classList.toggle('hidden',!state.unreadCount);
  $('inbox-window').textContent=state.unreadCount>state.inbox.length?'(显示最近 '+state.inbox.length+' 条)':'';
  $('session-list').innerHTML=visible.length?visible.map(sessionNode).join(''):
    '<div class="subtle" style="padding:12px">无匹配会话</div>';
  if(state.view==='inbox')$('inbox-items').innerHTML=state.inbox.length?
    groupedInbox().map(inboxGroupCard).join(''):
    '<div class="empty"><div class="empty-symbol"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4z M4 14h5l2 3h2l2-3h5"/></svg></div><strong>暂无消息</strong></div>';  refreshClock();
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
    const serverLocale=p.settings?.locale;
    if(serverLocale&&!i18n.hasUserChanged()&&serverLocale!==i18n.getLocale())i18n.setLocale(serverLocale);
    if(!localeSynced){
      localeSynced=true;
      if(!serverLocale||i18n.hasUserChanged())api('POST','/api/settings',{locale:i18n.getLocale()}).catch(error=>console.error(error));
    }
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
      const notice=new Notification(n.title,{body:n.body,tag:n.notificationId?'attnwall:'+n.notificationId:n.kind==='batch'?'attnwall-batch':undefined,icon:'/icons/attnwall-coral-v1-192.png'});
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
    (m.pending?' · '+esc(m.pending):'')+'</div><div class="bubble" data-i18n-skip>'+esc(m.body)+'</div>'+
    (m.pending==='failed'?'<button class="text-button retry-button" data-retry="'+esc(m.id)+'">重试 · '+esc(m.error||'未送达')+'</button>':'')+'</div>'
  ).join(''):'<div class="empty"><strong>暂无消息</strong></div>';
  if(nearBottom)el.scrollTop=el.scrollHeight;
  $('history-older').classList.toggle('hidden',!data.hasMore);
  const h=data.history;
  $('history-status').textContent=h?.state==='error'?'同步失败：'+(h.error||'未知错误'):['queued','loading','syncing'].includes(h?.state)?'同步中…':'';
  $('history-retry').classList.toggle('hidden',!['codex','chatgpt-web','codex-web','deepseek-web'].includes(s.runtime)||h?.state!=='error');
  $('history-status').closest('.history-toolbar').classList.toggle('hidden',!data.hasMore&&!$('history-status').textContent);
}
function supportsImage(s){return ['codex','dsh','chatgpt-web','codex-web','deepseek-web'].includes(s?.runtime);}
function updateComposeControl(){
  $('compose').querySelector('button[type="submit"]').disabled=state.sendingReply||(!$('compose-text').value.trim()&&!$('compose-image').files?.length);
}
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
  updateComposeControl();
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
  button.disabled=state.settings.instantEnabled===false;
  button.title=button.disabled?'即时通知已在设置中关闭':'任务完成后立即通知';
  button.textContent=enabled?'快速模式：开':'快速模式：关';
  button.classList.toggle('instant-active',enabled);
  button.setAttribute('aria-pressed',String(enabled));
  button.setAttribute('aria-label',button.disabled?'即时通知已在设置中关闭':enabled?'关闭快速模式':'开启快速模式');
}
async function loadConversation(){
  const id=state.selected;if(!id)return;
  const s=state.sessions.find(x=>x.id===id);if(!s)return;
  updateInstantControl(!!s.instant_mode);
  $('mark-session-read').classList.toggle('hidden',!s.unread);
  updateComposeControl();
  $('conversation-name').textContent=s.title;
  $('conversation-runtime').textContent=({'codex':'Codex','codex-web':'Codex Web','chatgpt-web':'ChatGPT','dsh':'DeepSeek DSH','deepseek-web':'DeepSeek'})[s.runtime]||s.runtime;
  $('conversation-path').textContent=s.cwd||'';
  $('compose-image-label').classList.toggle('hidden',!supportsImage(s));
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
    const result=last?.state==='cancelled'?'消息已读，已取消补发':last?last.accepted?
      '推送服务已接受 · HTTP '+esc(last.code):
      '发送失败 · '+esc(last.code||'网络错误')+' · '+esc(last.reason||'')+(last.retryAt?' · 将自动重试':''):
      '未测试';
    return '<div class="push-device-row"><div><strong>'+esc(d.name||'浏览器设备')+'</strong>'+
      '<small>'+esc(d.provider)+' · '+result+'</small></div>'+
      '<button class="outline" type="button" data-push-test="'+esc(d.id)+'">测试通知</button></div>';
  }).join(''):'<div class="muted">暂无设备</div>';
}
function renderSettings(){
  if(document.activeElement?.closest('#settings-form'))return;
  const s=state.settings;
  $('interval').value=s.intervalMin;$('dnd-enabled').checked=s.dndEnabled;
  updateDndSchedule();
  $('dnd-start').value=s.dndStart;$('dnd-end').value=s.dndEnd;
  $('time-zone').value=s.timeZone;$('instant-enabled').checked=s.instantEnabled;
}
function updateDndSchedule(){
  const enabled=$('dnd-enabled').checked;
  $('dnd-schedule').classList.toggle('hidden',!enabled);
  $('dnd-enabled').setAttribute('aria-expanded',String(enabled));
  $('dnd-schedule').querySelectorAll('input').forEach(input=>{input.disabled=!enabled;});
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
  state.pushSubscribed=true;renderNotifyButton();await syncAppBadge(state.unreadCount);toast('设备通知已启用');
}
async function detectPush(){
  try{if('serviceWorker'in navigator){
    const reg=await navigator.serviceWorker.getRegistration('/');
    state.pushSubscribed=!!(reg&&await reg.pushManager?.getSubscription());renderNotifyButton();
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
$('inbox-items').addEventListener('keydown',e=>{const card=e.target.closest('[data-session]');if(card&&e.target===card&&(e.key==='Enter'||e.key===' ')){e.preventDefault();openSession(card.dataset.session);}});
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
$('dnd-enabled').addEventListener('change',updateDndSchedule);
$('settings-button').addEventListener('click',()=>navigate('settings'));
document.querySelector('.mobile-nav').addEventListener('click',e=>{
  const b=e.target.closest('[data-nav]');if(!b)return;
  if(b.dataset.nav==='sessions'){$('application').classList.add('show-sessions');document.querySelectorAll('.mobile-nav button').forEach(x=>x.classList.toggle('active',x===b));}
  else navigate(b.dataset.nav);
});
$('compose-text').addEventListener('input',updateComposeControl);
$('compose-image').addEventListener('change',()=>{
  const file=$('compose-image').files?.[0];
  if(file&&(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>3000000)){
    $('compose-image').value='';toast('请选择小于 3MB 的 PNG、JPG 或 WebP 图片');
  }
  renderSelectedAttachment();
});
$('compose').addEventListener('submit',async e=>{
  e.preventDefault();const text=$('compose-text').value.trim(),file=$('compose-image').files?.[0];
  if((!text&&!file)||state.sendingReply)return;
  const sessionId=state.selected,draft=$('compose-text').value;
  state.sendingReply=true;updateComposeControl();
  try{
    const id=crypto.randomUUID();
    if(file){
      const session=state.sessions.find(s=>s.id===sessionId);
      if(!supportsImage(session))throw new Error('当前会话不支持图片附件');
      if(file.size>3000000)throw new Error('图片不得超过 3MB');
      const data=await fileToBase64(file);
      await api('POST','/api/replies/image',{sessionId,text,id,image:{data,type:file.type,name:file.name}});
    }else await api('POST','/api/replies',{sessionId,text,id});
    if(state.selected===sessionId&&$('compose-text').value===draft&&$('compose-image').files?.[0]===file){
      $('compose-text').value='';$('compose-image').value='';renderSelectedAttachment();
    }
    toast('已发送到队列');await loadConversation();
  }catch(err){toast(err.message);}
  finally{state.sendingReply=false;updateComposeControl();}
});
$('conversation-messages').addEventListener('click',async e=>{
  const button=e.target.closest('[data-retry]');if(!button)return;
  try{await api('POST','/api/replies/retry',{id:button.dataset.retry});toast('重新加入发送队列');await loadConversation();}
  catch(err){toast(err.message);}
});
$('settings-form').addEventListener('submit',async e=>{
  e.preventDefault();try{
    const dndEnabled=$('dnd-enabled').checked;
    const settings={intervalMin:Number($('interval').value),dndEnabled,locale:i18n.getLocale(),
      dndStart:dndEnabled?$('dnd-start').value:state.settings.dndStart,dndEnd:dndEnabled?$('dnd-end').value:state.settings.dndEnd,timeZone:dndEnabled?$('time-zone').value.trim():state.settings.timeZone,
      instantEnabled:$('instant-enabled').checked};
    await api('POST','/api/settings',settings);$('settings-feedback').textContent='已保存';toast('提醒规则已更新');await loadState();
  }catch(err){$('settings-feedback').textContent=err.message;}
});
$('settings-form').addEventListener('input',()=>{$('settings-feedback').textContent='';});
window.addEventListener('attnwall:localechange',event=>{
  if(!event.detail.userInitiated||!$('login').classList.contains('hidden'))return;
  state.settings.locale=event.detail.locale;
  api('POST','/api/settings',{locale:event.detail.locale}).catch(error=>console.error(error));
  render();refreshClock();
  if(state.view==='conversation'&&state.selected)loadConversation().catch(error=>console.error(error));
});
$('copy-browser-config').addEventListener('click',async()=>{
  const out=$('browser-config-feedback');
  try{
    const setup=await api('GET','/api/browser/setup');
    const data=JSON.stringify({kind:'attnwall-browser-v1',hub:location.origin,browserToken:setup.browserToken});
    await navigator.clipboard.writeText(data);
    out.textContent='已复制';
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
      '推送失败：'+(item?.code?'HTTP '+item.code:'网络错误')+' · '+(item?.reason||'网络问题')+(item?.retryAt?' · 已安排自动重试':'');
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
  if(source==='codex'){$('codex-create-dialog').showModal();}
  else if(source==='dsh')$('attach-dialog').showModal();
  else if(source==='web'){
    navigate('settings');
    document.querySelector('.browser-onboarding').open=true;
    document.querySelector('.browser-onboarding')?.scrollIntoView({block:'start',behavior:'smooth'});
  }
});
const codexCreation={id:null,pending:false};
$('codex-create-cancel').addEventListener('click',()=>$('codex-create-dialog').close());
$('codex-create-form').addEventListener('submit',async event=>{
  event.preventDefault();if(codexCreation.pending)return;
  codexCreation.pending=true;codexCreation.id ||= crypto.randomUUID();
  const form=$('codex-create-form'),status=$('codex-create-status');
  const inputs=[...form.querySelectorAll('input,button[type="submit"]')];
  const request={id:codexCreation.id,host:$('codex-create-host').value.trim(),title:$('codex-create-name').value.trim(),cwd:$('codex-create-cwd').value.trim()};
  inputs.forEach(input=>{input.disabled=true;});status.textContent='等待连接器…';
  try{
    let result=(await api('POST','/api/sessions/new-codex',request)).request;
    for(let attempt=0;attempt<85;attempt++){
      if(result.state==='complete'){
        codexCreation.id=null;$('codex-create-dialog').close();status.textContent='';
        await loadState();openSession(result.session_id);return;
      }
      if(result.state==='failed'){codexCreation.id=null;throw new Error(result.error||'创建失败');}
      status.textContent=result.state==='queued'?'等待连接器…':'正在创建…';
      await new Promise(resolve=>setTimeout(resolve,700));
      result=(await api('GET','/api/sessions/creation?id='+encodeURIComponent(request.id))).request;
    }
    status.textContent='连接器尚未返回结果；可稍后重试查询。';
  }catch(error){status.textContent=error.message;}
  finally{codexCreation.pending=false;inputs.forEach(input=>{input.disabled=false;});}
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
