import { spawn,spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
export class RpcProcess extends EventEmitter {
  constructor(executable,args,options={}) {
    super();this.executable=executable;this.args=args;this.options=options;
    this.child=null;this.pending=new Map();this.counter=1;
  }
  async start() {
    if(this.child) return;
    const isWindows=process.platform==='win32';
    const useShell=isWindows&&!/\.exe$/i.test(this.executable);
    // Windows npm scripts are .cmd shims; shell command is fixed and not user-provided.
    const child=spawn(useShell?'cmd.exe':this.executable,
      useShell?['/d','/s','/c',[this.executable,...this.args].join(' ')]:this.args,
      {cwd:this.options.cwd||process.cwd(),env:this.options.env||process.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child=child;
    child.stderr.on('data',d=>this.emit('stderr',String(d)));
    createInterface({input:child.stdout}).on('line',line=>{
      let frame;try{frame=JSON.parse(line);}catch{return;}
      if(frame.id!==undefined && (frame.result!==undefined||frame.error!==undefined)) {
        const p=this.pending.get(frame.id);if(!p)return;
        this.pending.delete(frame.id);clearTimeout(p.timer);
        if(frame.error)p.reject(new Error(frame.error.message||JSON.stringify(frame.error)));
        else p.resolve(frame.result);
      }else if(frame.id!==undefined && frame.method)this.emit('request',frame);
      else if(frame.method)this.emit('notification',frame.method,frame.params||{});
    });
    child.on('error',e=>this.fail(e));
    child.on('exit',(code,signal)=>this.fail(new Error('Runtime exited ('+code+', '+signal+')')));
    await new Promise((resolve,reject)=>{
      if(child.pid)resolve();else child.once('spawn',resolve).once('error',reject);
    });
  }
  fail(error) {
    const p=this.pending;this.pending=new Map();
    for(const value of p.values()){clearTimeout(value.timer);value.reject(error);}
    this.child=null;this.emit('disconnected',error);
  }
  write(frame) {
    if(!this.child||this.child.stdin.destroyed)throw new Error('Runtime disconnected');
    this.child.stdin.write(JSON.stringify(frame)+'\n');
  }
  request(method,params={},timeout=30000) {
    const id=this.counter++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(method+' timed out'));},timeout);
      this.pending.set(id,{resolve,reject,timer});
      try{this.write({jsonrpc:'2.0',id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  notify(method,params={}) {this.write({jsonrpc:'2.0',method,params});}
  respond(id,result){this.write({jsonrpc:'2.0',id,result});}
  close(){
    const child=this.child;this.child=null;
    // The official npm entry point can itself launch codex.exe. Releasing a
    // dedicated Windows writer requires closing that entire owned process tree.
    if(child?.pid&&process.platform==='win32'&&this.options.killTree){
      spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:5000});
    }else child?.kill();
  }
}
