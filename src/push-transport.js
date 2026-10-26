import {execFileSync} from 'node:child_process';

function windowsProxy(){
  try{
    const key='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const read=value=>execFileSync('reg.exe',['query',key,'/v',value],{encoding:'utf8',windowsHide:true,timeout:2000,stdio:['ignore','pipe','ignore']});
    if(!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(read('ProxyEnable')))return null;
    const server=read('ProxyServer').match(/ProxyServer\s+REG_SZ\s+(.+)/i)?.[1]?.trim();
    if(!server)return null;
    if(!server.includes('='))return server;
    const schemes=Object.fromEntries(server.split(';').map(x=>x.trim().split('=')));
    return schemes.https||schemes.http||null;
  }catch{return null;}
}

// web-push uses https.request, which does not automatically follow Windows' proxy.
export function pushTransport({env=process.env,platform=process.platform,readWindowsProxy=windowsProxy}={}){
  const explicit=env.ATTNWALL_PUSH_PROXY;
  if(explicit==='direct')return {timeout:15000};
  const configured=explicit||env.HTTPS_PROXY||env.https_proxy||env.HTTP_PROXY||env.http_proxy||
    (platform==='win32'?readWindowsProxy():null);
  if(!configured)return {timeout:15000};
  const proxy=new URL(configured.includes('://')?configured:'http://'+configured);
  if(!['http:','https:'].includes(proxy.protocol))throw new Error('Push proxy must use HTTP or HTTPS');
  return {timeout:15000,proxy:proxy.href};
}

export function pushOptions(endpoint,transport,{env=process.env}={}){
  const {hostname,port}=new URL(endpoint);
  const bypass=(env.NO_PROXY||env.no_proxy||'').split(',').some(raw=>{
    const entry=raw.trim().toLowerCase();
    if(entry==='*')return true;
    if(!entry)return false;
    const [host,targetPort]=entry.replace(/^\*?\./,'').split(':');
    return (!targetPort||targetPort===(port||'443'))&&(hostname===host||hostname.endsWith('.'+host));
  });
  return bypass?{timeout:transport.timeout}:transport;
}

export function pushFailure(error){
  const codes=new Set();
  const visit=(e,depth=0)=>{
    if(!e||depth>4)return;
    if(typeof e.code==='string'&&/^[A-Z_0-9]+$/.test(e.code))codes.add(e.code);
    visit(e.cause,depth+1);
    for(const child of e.errors||[])visit(child,depth+1);
  };
  visit(error);
  if(/socket timeout/i.test(error?.message||''))codes.add('ETIMEDOUT');
  let reason;
  try{reason=JSON.parse(error?.body||'{}').reason;}catch{}
  // Network messages can contain the subscription URL or proxy credentials.
  const redact=text=>String(text).replace(/https?:\/\/[^\s"'<>]+/gi,'[redacted URL]').slice(0,180);
  const code=[...codes].join(', ');
  const hint=[...codes].some(x=>['ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','ECONNREFUSED'].includes(x))
    ?'无法连接推送服务，请检查网络或推送代理':null;
  return {code:error?.statusCode||null,reason:redact(reason||hint||error?.message||error?.name||'Push transport error')+(code?' ['+code+']':'')};
}
