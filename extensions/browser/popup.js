const $=id=>document.getElementById(id);$('extension-version').textContent='网页端连接器 · '+chrome.runtime.getManifest().version;
async function refresh(){
  const s=await chrome.storage.local.get(['hub','enabled','bridgeStatus']);
  const status=s.bridgeStatus||{};
  let title='尚未连接 AttnWall',detail='请按下面 3 步连接';
  let color='#cf9a5b';
  if(s.enabled&&s.hub){
    title=status.error?'连接异常':'已配置 · '+(status.lastRuntime?.replace('-web',' Web')||'等待会话');
    detail=status.error||((status.lastSyncedAt?'最近同步 '+new Date(status.lastSyncedAt).toLocaleTimeString():'等待打开支持的网页会话')+' · '+s.hub);
    color=status.error?'#d47c57':'#38ba97';
  }
  $('status-title').textContent=title;
  $('status-detail').textContent=detail;
  $('dot').style.background=color;
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
  $('tab-title').textContent=platform?'当前标签已支持：'+platform:'当前标签不是受支持的会话页';
  $('tab-detail').textContent=platform?'保持页面打开；首次历史静默导入。':'需要进入具体聊天/任务页面，主页不会同步。';
  $('tab-dot').style.background=platform?'#38ba97':'#cf9a5b';
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
    $('connection').value='';$('feedback').textContent='连接成功。现在打开会话网页并保持标签打开。';
    $('feedback').style.color='#208e72';
    await chrome.storage.local.set({bridgeStatus:{error:'',at:Date.now()}});
  }catch(e){$('feedback').textContent=e.message;$('feedback').style.color='#bb4949';}
  finally{b.disabled=false;await refresh();}
});
$('disconnect').addEventListener('click',async()=>{
  await chrome.storage.local.set({enabled:false,key:'',bridgeStatus:{error:'',at:Date.now()}});
  $('feedback').textContent='已断开；浏览器不会再同步消息。';await refresh();
});
$('dashboard').addEventListener('click',async()=>{
  const {hub}=await chrome.storage.local.get('hub');
  if(hub)await chrome.tabs.create({url:hub});
});
void refresh();
