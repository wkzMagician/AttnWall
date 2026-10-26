const $=id=>document.getElementById(id);$('extension-version').textContent=chrome.runtime.getManifest().version;
async function refresh(){
  const s=await chrome.storage.local.get(['hub','enabled','bridgeStatus']);
  const status=s.bridgeStatus||{};
  let title='未连接',detail='',state='idle';
  if(s.enabled&&s.hub){
    title=status.error?'连接异常':'已配置';
    detail=status.error||new URL(s.hub).hostname+(status.lastSyncedAt?' · '+new Date(status.lastSyncedAt).toLocaleTimeString(): ' · 等待会话');
    state=status.error?'error':'connected';
  }
  $('status-title').textContent=title;
  $('status-detail').textContent=detail;
  $('dot').dataset.state=state;
  $('connection-settings').open=!s.enabled;
  $('connect').disabled=!$('connection').value.trim();
  $('disconnect').disabled=!s.enabled;
  $('dashboard').disabled=!s.hub;
}
async function currentTabStatus(){
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const url=tab?.url||'';
  let platform='';
  try{
    const u=new URL(url);
    if(u.hostname==='chatgpt.com'&&/^(?:\/g\/g-[a-zA-Z0-9_-]+|\/g-[a-zA-Z0-9_-]+)?\/c\/[a-zA-Z0-9_-]{8,150}(?:\/|$)/.test(u.pathname))platform='ChatGPT 会话';
    else if(u.hostname==='chatgpt.com'&&/^\/codex\/(?:cloud\/)?tasks\/[a-zA-Z0-9_-]{8,150}/.test(u.pathname))platform='Codex Web 任务';
    else if(u.hostname==='chat.deepseek.com'&&/^\/a\/chat\/s\/[a-zA-Z0-9_-]{8,150}/.test(u.pathname))platform='DeepSeek 会话';
  }catch{}
  $('tab-title').textContent=platform||'当前页不可同步';
  $('tab-detail').textContent='';
  $('tab-dot').dataset.state=platform?'connected':'idle';
}
void currentTabStatus();
function validate(raw){
  const value=JSON.parse(raw);
  if(value?.kind!=='attnwall-browser-v1'||typeof value.browserToken!=='string'||!/^[0-9a-f]{48}$/.test(value.browserToken))
    throw new Error('配置格式错误，请从 AttnWall 设置页复制');
  const url=new URL(value.hub);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/')
    throw new Error('连接地址不应包含密码、路径或参数');
  const local=['127.0.0.1','localhost'].includes(url.hostname);
  if(!((url.protocol==='http:'&&local)||url.protocol==='https:'))
    throw new Error('只允许 HTTPS 或本机 localhost HTTP');
  return {hub:url.origin,browserToken:value.browserToken,origin:url.origin+'/*'};
}
$('connection').addEventListener('input',()=>{$('connect').disabled=!$('connection').value.trim();$('feedback').textContent='';});
$('connect').addEventListener('click',async()=>{
  const b=$('connect');b.disabled=true;$('feedback').textContent='';
  try{
    const c=validate($('connection').value.trim());
    if(c.hub.startsWith('https:')){
      const granted=await chrome.permissions.request({origins:[c.origin]});
      if(!granted)throw new Error('未授予 AttnWall 服务的网络访问权限');
    }
    const prev=await chrome.storage.local.get(['hub','key','enabled']);
    await chrome.storage.local.set({hub:c.hub,key:c.browserToken,enabled:true});
    try{
      const r=await chrome.runtime.sendMessage({type:'ATTNWALL_CHECK'});
      if(!r?.ok)throw new Error(r?.error||'AttnWall 未响应');
    }catch(e){await chrome.storage.local.set(prev);throw e;}
    $('connection').value='';$('feedback').textContent='已连接';
    $('feedback').dataset.state='success';
    await chrome.storage.local.set({bridgeStatus:{error:'',at:Date.now()}});
  }catch(e){$('feedback').textContent=e.message;$('feedback').dataset.state='error';}
  finally{b.disabled=false;await refresh();}
});
$('disconnect').addEventListener('click',async()=>{
  await chrome.storage.local.set({enabled:false,key:'',bridgeStatus:{error:'',at:Date.now()}});
  $('feedback').textContent='已断开';$('feedback').dataset.state='success';await refresh();
});
$('dashboard').addEventListener('click',async()=>{
  const {hub}=await chrome.storage.local.get('hub');
  if(hub)await chrome.tabs.create({url:hub});
});
void refresh();
