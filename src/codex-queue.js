import {spawn,spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname,isAbsolute,join} from 'node:path';

export function codexQueueCommand(executable=process.env.CODEX_QUEUE_BIN||process.env.CODEX_BIN||'codex'){
  if(/\.m?js$/i.test(executable))return {command:process.execPath,args:[executable]};
  if(process.platform!=='win32')return {command:executable,args:[]};
  const paths=isAbsolute(executable)?[executable]:
    (spawnSync('where.exe',[executable],{encoding:'utf8',windowsHide:true}).stdout||'').trim().split(/\r?\n/).filter(Boolean);
  for(const path of paths){
    if(/\.exe$/i.test(path)&&existsSync(path))return {command:path,args:[]};
    // npm's Windows shim needs cmd.exe. Run its official Node entry point
    // directly so reply text stays an argv value, never shell source code.
    const entry=join(dirname(path),'node_modules','@openai','codex','bin','codex.js');
    if(/\.(cmd|ps1)$/i.test(path)&&existsSync(entry))return {command:process.execPath,args:[entry]};
  }
  throw new Error('无法安全调用 Codex queue；请将 CODEX_QUEUE_BIN 设置为 codex.exe 或官方 codex.js 的完整路径');
}

export async function queueCodexMessage(nativeId,text,{executable,env=process.env,cwd=process.cwd()}={}){
  const cli=codexQueueCommand(executable);
  return new Promise((resolve,reject)=>{
    const child=spawn(cli.command,[...cli.args,'queue','--thread',nativeId,'--message',text],
      {cwd,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    const timer=setTimeout(()=>{
      child.kill();reject(new Error('Codex queue 提交结果不确定；请检查原会话，避免重复重试'));
    },20000);
    child.stdout.on('data',d=>{stdout=(stdout+d).slice(-32000);});
    child.stderr.on('data',d=>{stderr=(stderr+d).slice(-2000);});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{
      clearTimeout(timer);
      if(code!==0){reject(new Error('Codex queue 失败：'+(stderr.trim()||'exit '+code).slice(0,500)));return;}
      const receipt=stdout.match(/Queued message ([a-zA-Z0-9-]+) for thread ([a-zA-Z0-9-]+)\./);
      if(!receipt||receipt[2]!==nativeId){reject(new Error('Codex queue 回执不确定；请检查原会话，避免重复重试'));return;}
      resolve({queued:true,queueId:receipt[1],nativeId:receipt[2]});
    });
  });
}
