import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const DEFAULTS = Object.freeze({
  intervalMin: 20, dndEnabled: true, dndStart: '00:00', dndEnd: '08:00',
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  instantEnabled: true,
  locale: null
});

export function inDnd(time, settings) {
  if (!settings.dndEnabled || settings.dndStart === settings.dndEnd) return false;
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: settings.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(new Date(time));
  const hhmm = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const now = hhmm(clock), start = hhmm(settings.dndStart), end = hhmm(settings.dndEnd);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function nextBoundary(time, intervalMin) {
  const interval = intervalMin * 60_000;
  return (Math.floor(time / interval) + 1) * interval;
}
export function secretEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
export function loadSecrets(path = resolve('.data/secrets.json')) {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ accessToken: randomBytes(24).toString('hex'), connectorToken: randomBytes(24).toString('hex'), browserToken: randomBytes(24).toString('hex') }, null, 2), { mode: 0o600, flag: 'wx' });
  }
  const secrets=JSON.parse(readFileSync(path,'utf8'));
  if(!secrets.browserToken){
    secrets.browserToken=randomBytes(24).toString('hex');
    writeFileSync(path,JSON.stringify(secrets,null,2),{mode:0o600});
  }
  return secrets;
}

export class Store {
  constructor(file = resolve('.data/attnwall.db')) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, host TEXT NOT NULL, runtime TEXT NOT NULL, native_id TEXT NOT NULL, title TEXT NOT NULL, cwd TEXT NOT NULL DEFAULT \'\', status TEXT NOT NULL DEFAULT \'idle\', updated_at INTEGER NOT NULL, UNIQUE(host,runtime,native_id));' +
      'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), external_id TEXT, role TEXT NOT NULL, body TEXT NOT NULL, priority TEXT NOT NULL DEFAULT \'normal\', kind TEXT NOT NULL DEFAULT \'message\', created_at INTEGER NOT NULL, read_at INTEGER, notified_at INTEGER, UNIQUE(session_id,external_id));' +
      'CREATE TABLE IF NOT EXISTS replies (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), text TEXT NOT NULL, state TEXT NOT NULL DEFAULT \'queued\', error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, claim_until INTEGER, kind TEXT NOT NULL DEFAULT \'message\', approval_key TEXT);' +
      'CREATE TABLE IF NOT EXISTS subscriptions (endpoint TEXT PRIMARY KEY, subscription TEXT NOT NULL, device_name TEXT NOT NULL, created_at INTEGER NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS history_requests (session_id TEXT PRIMARY KEY REFERENCES sessions(id), state TEXT NOT NULL DEFAULT \'queued\', error TEXT, updated_at INTEGER NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), mime TEXT NOT NULL, name TEXT NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL);' +      'CREATE TABLE IF NOT EXISTS run_completions (session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL, completed_at INTEGER NOT NULL, status TEXT NOT NULL, PRIMARY KEY(session_id,run_id));' +
      "CREATE TABLE IF NOT EXISTS notification_events (id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,broadcast_at INTEGER);" +
      "CREATE TABLE IF NOT EXISTS push_deliveries (event_id TEXT NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,endpoint TEXT NOT NULL,device_name TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,lease_until INTEGER,code INTEGER,reason TEXT,PRIMARY KEY(event_id,endpoint));" +
      'CREATE INDEX IF NOT EXISTS ix_push_due ON push_deliveries(state,next_at);' +
      "CREATE TABLE IF NOT EXISTS session_creations (id TEXT PRIMARY KEY,host TEXT NOT NULL,title TEXT NOT NULL,cwd TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',session_id TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);" +
      'CREATE INDEX IF NOT EXISTS ix_messages_notify ON messages(priority,notified_at,created_at);' +
      'CREATE INDEX IF NOT EXISTS ix_replies ON replies(state,created_at);'
    );
    // Additive migration for existing installations.
    if(!this.db.prepare('PRAGMA table_info(sessions)').all().some(x=>x.name==='instant_mode')) this.db.exec('ALTER TABLE sessions ADD COLUMN instant_mode INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(sessions)').all().some(x=>x.name==='activity_at')) this.db.exec('ALTER TABLE sessions ADD COLUMN activity_at INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(replies)').all().some(x=>x.name==='kind'))this.db.exec("ALTER TABLE replies ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'");
    if(!this.db.prepare('PRAGMA table_info(replies)').all().some(x=>x.name==='approval_key'))this.db.exec('ALTER TABLE replies ADD COLUMN approval_key TEXT');
    if(!this.db.prepare('PRAGMA table_info(replies)').all().some(x=>x.name==='attachment_id'))this.db.exec('ALTER TABLE replies ADD COLUMN attachment_id TEXT');
    if(!this.db.prepare('PRAGMA table_info(replies)').all().some(x=>x.name==='message_id')){
      this.db.exec('ALTER TABLE replies ADD COLUMN message_id TEXT');
      this.db.exec("UPDATE replies SET message_id=(SELECT m.id FROM messages m WHERE m.session_id=replies.session_id AND m.external_id='reply:'||replies.id)");
    }
    if(!this.db.prepare('PRAGMA table_info(sessions)').all().some(x=>x.name==='source_url'))this.db.exec("ALTER TABLE sessions ADD COLUMN source_url TEXT NOT NULL DEFAULT ''");
    if(!this.db.prepare('PRAGMA table_info(messages)').all().some(x=>x.name==='queued_at')){
      this.db.exec('ALTER TABLE messages ADD COLUMN queued_at INTEGER NOT NULL DEFAULT 0');
      // One-time backfill only: never write to notification rows on every Store startup.
      this.db.prepare("UPDATE messages SET queued_at=CASE WHEN created_at>? AND created_at<? THEN created_at ELSE ? END WHERE role='agent' AND priority='normal' AND notified_at IS NULL AND queued_at=0")
        .run(Date.now()-86400000,Date.now()+60000,Date.now());
    }
    if(!this.db.prepare('PRAGMA table_info(messages)').all().some(x=>x.name==='run_id')){
      this.db.exec("ALTER TABLE messages ADD COLUMN run_id TEXT NOT NULL DEFAULT ''");
      // Upgrade: retire old per-message push queue, preserving all unread messages.
      this.db.prepare("UPDATE messages SET notified_at=? WHERE role='agent' AND notified_at IS NULL").run(Date.now());
    }
    this.db.exec('CREATE TABLE IF NOT EXISTS run_starts (session_id TEXT NOT NULL REFERENCES sessions(id),run_id TEXT NOT NULL,started_at INTEGER NOT NULL,PRIMARY KEY(session_id,run_id));CREATE INDEX IF NOT EXISTS ix_run_starts_time ON run_starts(started_at);CREATE INDEX IF NOT EXISTS ix_messages_run ON messages(session_id,run_id,role,created_at)');
    this.db.exec(`INSERT OR IGNORE INTO run_starts
      SELECT m.session_id,m.run_id,MIN(MIN(m.created_at,c.completed_at)) FROM messages m
      JOIN run_completions c ON c.session_id=m.session_id AND c.run_id=m.run_id
      WHERE m.role='agent' AND m.read_at IS NULL AND m.notified_at IS NULL AND m.run_id<>''
      GROUP BY m.session_id,m.run_id`);
    for (const [k,v] of Object.entries(DEFAULTS)) this.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').run(k,JSON.stringify(v));
  }
  close() { this.db.close(); }
  setting(key) { const row=this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row?JSON.parse(row.value):null; }
  settings() { return Object.fromEntries(this.db.prepare('SELECT * FROM settings').all().map(x=>[x.key,JSON.parse(x.value)])); }
  updateSettings(patch) {
    const next={...this.settings(),...patch};
    if(!Number.isInteger(next.intervalMin)||next.intervalMin<1||next.intervalMin>1440) throw new Error('Interval must be 1..1440 minutes');
    for(const field of ['dndStart','dndEnd']) if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(next[field])) throw new Error('Invalid DND time');
    try { new Intl.DateTimeFormat('en-US',{timeZone:next.timeZone}); }catch{throw new Error('Invalid time zone');}
    if(typeof next.dndEnabled!=='boolean'||typeof next.instantEnabled!=='boolean') throw new Error('Invalid toggle');
    if(next.locale!==null&&!['zh-CN','en'].includes(next.locale)) throw new Error('Invalid locale');
    for(const [k,v] of Object.entries(patch)){
      if(!(k in DEFAULTS)) throw new Error('Unsupported setting: '+k);
      this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,JSON.stringify(v));
    }
    return this.settings();
  }
  session({host='local',runtime,nativeId,title,cwd='',status='idle',updatedAt=Date.now(),activityAt=null,sourceUrl=''}) {
    if(!['codex','dsh','codex-web','deepseek-web','chatgpt-web'].includes(runtime)||!nativeId||!host) throw new Error('Unsupported runtime/session');
    const id=host+':'+runtime+':'+nativeId;
    // 0 marks an unknown source activity time. Never infer activity from an import or polling time.
    const timestamp=Number(activityAt);
    const actual=Number.isFinite(timestamp)&&timestamp>0&&timestamp<=Date.now()+300000
      ? Math.round(timestamp) : 0;
    const initialActivity=actual || (runtime==='dsh'||runtime.endsWith('-web') ? Date.now() : 0);
    this.db.prepare("INSERT INTO sessions(id,host,runtime,native_id,title,cwd,status,updated_at,activity_at,source_url) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=CASE WHEN excluded.title=excluded.native_id THEN sessions.title ELSE excluded.title END,cwd=CASE WHEN excluded.cwd='' THEN sessions.cwd ELSE excluded.cwd END,status=excluded.status,updated_at=MAX(sessions.updated_at,excluded.updated_at),activity_at=CASE WHEN excluded.activity_at>0 THEN MAX(sessions.activity_at,excluded.activity_at) ELSE sessions.activity_at END,source_url=CASE WHEN excluded.source_url<>'' THEN excluded.source_url ELSE sessions.source_url END")
      .run(id,host,runtime,nativeId,String(title||nativeId).slice(0,250),String(cwd||''),status,updatedAt,
        this.sessionById(id)?actual:initialActivity,String(sourceUrl||'').slice(0,500));
    return id;
  }  sessions() {
    return this.db.prepare("SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id AND m.role='agent' AND m.read_at IS NULL) unread, (SELECT COUNT(*) FROM replies r WHERE r.session_id=s.id AND r.state IN ('queued','sending','failed')) pending_replies FROM sessions s ORDER BY s.activity_at DESC, s.id DESC").all();
  }
  sessionById(id){return this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);}
  message({sessionId,externalId=null,role='agent',body,priority='normal',kind='message',runId='',createdAt=Date.now(),silent=false}) {
    if(!this.sessionById(sessionId)) throw new Error('Unknown session');
    if(!['agent','user','system'].includes(role)||!['normal','instant'].includes(priority)) throw new Error('Invalid message');
    const needsAttention=role==='agent'&&['approval','userInput'].includes(kind)&&!silent;
    if(needsAttention)priority='instant';
    if(!String(body||'').trim()) return null;
    const text=String(body).slice(0,100000);
    if(externalId&&this.db.prepare('SELECT id FROM messages WHERE session_id=? AND external_id=?').get(sessionId,externalId))return null;
    let echoedReply=null;
    if(role==='user'&&externalId&&!externalId.startsWith('reply:')){
      const placeholder=this.db.prepare("SELECT m.id FROM messages m JOIN replies r ON r.message_id=m.id WHERE m.session_id=? AND m.body=? AND m.external_id='reply:'||r.id AND r.state IN ('sending','sent') AND r.kind='message' ORDER BY r.created_at,r.id LIMIT 1").get(sessionId,text);
      if(placeholder){
        this.db.prepare('UPDATE messages SET external_id=? WHERE id=?').run(externalId,placeholder.id);
        return null;
      }
      echoedReply=this.db.prepare("SELECT id FROM replies WHERE session_id=? AND text=? AND message_id IS NULL AND state IN ('sending','sent') AND kind='message' ORDER BY created_at,id LIMIT 1").get(sessionId,text);
    }
    const id=randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try{
    const row=this.db.prepare('INSERT OR IGNORE INTO messages (id,session_id,external_id,role,body,priority,kind,created_at,read_at,notified_at,queued_at,run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,sessionId,externalId,role,text,priority,kind,createdAt,role==='agent'&&!silent?null:createdAt,role==='agent'&&!silent?null:createdAt,0,String(runId||'').slice(0,180));
    if(!row.changes){this.db.exec('COMMIT');return null;}
    if(echoedReply)this.db.prepare('UPDATE replies SET message_id=? WHERE id=?').run(id,echoedReply.id);
    this.db.prepare('UPDATE sessions SET updated_at=MAX(updated_at,?),activity_at=CASE WHEN ?=0 AND ?>0 AND ?<=? THEN MAX(activity_at,?) ELSE activity_at END WHERE id=?').run(createdAt,silent?1:0,createdAt,createdAt,Date.now()+300000,createdAt,sessionId);
    if(needsAttention){
      const now=Date.now();
      this.markInstantNotified(id,now);
      const locale=this.setting('locale')==='en'?'en':'zh-CN';
      this.enqueueNotification({kind:'instant',title:(locale==='en'?'Action required · ':'需要你处理 · ')+this.sessionById(sessionId).title,body:text.slice(0,180),sessionId,messageIds:[id]},{id:'instant:'+id,at:now});
    }else if(role==='agent'&&!silent&&runId){
      const completion=this.db.prepare('SELECT completed_at FROM run_completions WHERE session_id=? AND run_id=?').get(sessionId,runId);
      if(completion){
        const released=this.db.prepare("SELECT notified_at FROM messages WHERE session_id=? AND run_id=? AND role='agent' AND kind NOT IN ('approval','userInput') AND notified_at IS NOT NULL LIMIT 1").get(sessionId,runId);
        if(released)this.markInstantNotified(id,released.notified_at);
        else this.releaseCompletedRun(sessionId,runId,completion.completed_at);
      }
    }
    this.db.exec('COMMIT');
    return this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  enqueueNotification(payload,{id=randomUUID(),at=Date.now(),broadcast=true,targetId=null}={}){
    const notice={...payload,notificationId:id};
    const inserted=this.db.prepare('INSERT OR IGNORE INTO notification_events VALUES (?,?,?,?,?,?)')
      .run(id,payload.kind,JSON.stringify(notice),at,at+(payload.kind==='test'?120000:3600000),broadcast?null:at);
    if(inserted.changes){
      const insert=this.db.prepare('INSERT INTO push_deliveries(event_id,endpoint,device_name,next_at) VALUES (?,?,?,?)');
      for(const row of this.subscriptions())if(!targetId||targetId(row.endpoint))insert.run(id,row.endpoint,row.device_name,at);
    }
    return notice;
  }
  pendingBroadcasts(now=Date.now()){return this.db.prepare('SELECT id,payload FROM notification_events WHERE broadcast_at IS NULL AND expires_at>? ORDER BY created_at,id').all(now);}
  claimPushDeliveries(now=Date.now(),allowBatch=true){
    this.db.prepare('DELETE FROM notification_events WHERE expires_at<?').run(now-7*86400000);
    this.db.prepare("UPDATE push_deliveries SET state='expired',reason='通知已过期，未继续重试' WHERE state IN ('queued','sending') AND event_id IN (SELECT id FROM notification_events WHERE expires_at<=?)").run(now);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const jobs=this.db.prepare("SELECT d.*,e.payload,e.expires_at,s.subscription FROM push_deliveries d JOIN notification_events e ON e.id=d.event_id JOIN subscriptions s ON s.endpoint=d.endpoint WHERE ((d.state='queued' AND d.next_at<=?) OR (d.state='sending' AND d.lease_until<=?)) AND e.expires_at>? AND (? OR e.kind!='batch') ORDER BY e.created_at,d.next_at LIMIT 20").all(now,now,now,allowBatch?1:0);
      for(const job of jobs)this.db.prepare("UPDATE push_deliveries SET state='sending',attempts=attempts+1,lease_until=? WHERE event_id=? AND endpoint=?").run(now+120000,job.event_id,job.endpoint);
      this.db.exec('COMMIT');return jobs;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  finishPush(job,{accepted,code,reason,retryAfter=0},now=Date.now()){
    const attempts=job.attempts+1;
    const retry=!accepted&&(code===null||code===408||code===429||code>=500)&&attempts<7;
    const next=now+Math.max(retryAfter,Math.min(300000,30000*2**(attempts-1)));
    this.db.prepare('UPDATE push_deliveries SET state=?,next_at=?,lease_until=NULL,code=?,reason=? WHERE event_id=? AND endpoint=?')
      .run(accepted?'sent':retry?'queued':'failed',next,code,reason,job.event_id,job.endpoint);
  }
  notificationReport(id,at=Date.now()){
    const event=this.db.prepare('SELECT kind FROM notification_events WHERE id=?').get(id);
    return {notificationId:id,kind:event.kind,at,results:this.db.prepare('SELECT * FROM push_deliveries WHERE event_id=?').all(id).map(row=>({endpoint:row.endpoint,name:row.device_name,state:row.state,accepted:row.state==='sent',code:row.code,reason:row.reason,retryAt:row.state==='queued'?row.next_at:null}))};
  }
  startRun(sessionId,runId,{at=Date.now()}={}){
    if(!this.sessionById(sessionId)||typeof runId!=='string'||!runId.trim()||runId.length>180||!Number.isFinite(at)||at<=0)throw new Error('Invalid run start');
    this.db.prepare('INSERT INTO run_starts VALUES (?,?,?) ON CONFLICT(session_id,run_id) DO UPDATE SET started_at=MIN(run_starts.started_at,excluded.started_at)').run(sessionId,runId,at);
  }
  /** One durable notification per completed agent run. */
  completeRun(sessionId,runId,{status='completed',at=Date.now()}={}){
    if(!this.sessionById(sessionId)||typeof runId!=='string'||!runId.trim()||runId.length>180)throw new Error('Invalid run completion');
    if(!['completed','failed','interrupted'].includes(status))throw new Error('Invalid run status');
    if(this.db.prepare('SELECT 1 FROM run_completions WHERE session_id=? AND run_id=?').get(sessionId,runId))return null;
    this.db.exec('BEGIN');
    try{
      this.db.prepare('INSERT INTO run_completions VALUES (?,?,?,?)').run(sessionId,runId,at,status);
      // Older connectors have no start event: use the first live output if available.
      const first=this.db.prepare("SELECT MIN(created_at) at FROM messages WHERE session_id=? AND run_id=? AND role='agent' AND read_at IS NULL").get(sessionId,runId);
      this.startRun(sessionId,runId,{at:Math.min(first.at||at,at)});
      const last=this.releaseCompletedRun(sessionId,runId,at);
      this.db.exec('COMMIT');return last;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  releaseCompletedRun(sessionId,runId,at){
      const last=this.db.prepare("SELECT * FROM messages WHERE session_id=? AND run_id=? AND role='agent' AND notified_at IS NULL AND kind NOT IN ('approval','userInput') ORDER BY created_at DESC,rowid DESC LIMIT 1").get(sessionId,runId);
      if(last){
        if(last.priority==='instant'&&!this.setting('instantEnabled')){
          this.db.prepare("UPDATE messages SET priority='normal' WHERE session_id=? AND run_id=? AND notified_at IS NULL").run(sessionId,runId);
          last.priority='normal';
        }
        if(last.priority==='instant'){
          this.db.prepare("UPDATE messages SET notified_at=? WHERE session_id=? AND run_id=? AND role='agent' AND notified_at IS NULL").run(at,sessionId,runId);
          this.enqueueNotification({kind:'instant',title:'Instant · '+this.sessionById(sessionId).title,body:last.body.slice(0,180),sessionId,messageIds:[last.id]},{id:'instant:'+last.id,at});
        }
        else {
          this.db.prepare("UPDATE messages SET queued_at=0 WHERE session_id=? AND run_id=? AND notified_at IS NULL").run(sessionId,runId);
          this.db.prepare('UPDATE messages SET queued_at=? WHERE id=?').run(at,last.id);
        }
      }
      return last;
  }
  instantMode(id,enabled){
    if(!this.sessionById(id))throw new Error('Unknown session');
    this.db.prepare('UPDATE sessions SET instant_mode=? WHERE id=?').run(enabled?1:0,id);
    return this.sessionById(id);
  }
  messages(sessionId,limit=300) {return this.db.prepare('SELECT * FROM (SELECT * FROM messages WHERE session_id=? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC').all(sessionId,Math.min(500,Math.max(1,limit)));}
  inbox(limit=100) {return this.db.prepare("SELECT m.*,s.title,s.runtime,s.host FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.role='agent' AND m.read_at IS NULL ORDER BY m.created_at DESC LIMIT ?").all(Math.min(500,Math.max(1,limit)));}
  /** Only messages already released by the notification scheduler are shown in the inbox.
   * Instant messages are visible immediately, even if the push provider is unreachable.
   * Pending normal messages remain durable and available in an intentionally opened thread. */
  attentionFilter(){
    // Keep progress in history, but expose only the final output of each run.
    // Apply this at read time so existing installations are corrected as well.
    return `(m.run_id='' OR m.kind IN ('approval','userInput') OR m.rowid=(
      SELECT last.rowid FROM messages last WHERE last.session_id=m.session_id
      AND last.run_id=m.run_id AND last.role='agent' AND last.kind NOT IN ('approval','userInput')
      ORDER BY last.created_at DESC,last.rowid DESC LIMIT 1))`;
  }
  readyInbox(limit=100){
    return this.db.prepare("SELECT m.*,s.title,s.runtime,s.host FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.role='agent' AND m.read_at IS NULL AND (m.notified_at IS NOT NULL OR (m.priority='instant' AND m.kind IN ('approval','userInput'))) AND "+this.attentionFilter()+" ORDER BY m.created_at DESC LIMIT ?").all(Math.min(500,Math.max(1,limit)));
  }
  readyUnreadCount(sessionId=null){
    const sql="SELECT COUNT(*) count FROM messages m WHERE m.role='agent' AND m.read_at IS NULL AND (m.notified_at IS NOT NULL OR (m.priority='instant' AND m.kind IN ('approval','userInput'))) AND "+this.attentionFilter();
    return sessionId?this.db.prepare(sql+' AND session_id=?').get(sessionId).count:this.db.prepare(sql).get().count;
  }
  readySessions(){
    const counts=new Map(this.db.prepare("SELECT m.session_id,COUNT(*) count FROM messages m WHERE m.role='agent' AND m.read_at IS NULL AND (m.notified_at IS NOT NULL OR (m.priority='instant' AND m.kind IN ('approval','userInput'))) AND "+this.attentionFilter()+" GROUP BY m.session_id").all().map(r=>[r.session_id,r.count]));
    return this.sessions().map(s=>({...s,unread:counts.get(s.id)||0}));
  }
  unreadCount(sessionId=null) {
    return sessionId
      ? this.db.prepare("SELECT COUNT(*) count FROM messages WHERE role='agent' AND read_at IS NULL AND session_id=?").get(sessionId).count
      : this.db.prepare("SELECT COUNT(*) count FROM messages WHERE role='agent' AND read_at IS NULL").get().count;
  }
  markAllRead(sessionId=null, now=Date.now()) {
    const query = "UPDATE messages SET read_at=?,notified_at=COALESCE(notified_at,?) WHERE role='agent' AND read_at IS NULL"
      + (sessionId?" AND session_id=?":"");
    return sessionId
      ? this.db.prepare(query).run(now,now,sessionId).changes
      : this.db.prepare(query).run(now,now).changes;
  }
  messagePage(sessionId,{limit=120,beforeTime=null,beforeId=null}={}) {
    const n=Math.min(300,Math.max(1,Number(limit)||120));
    const older=beforeTime!==null&&beforeId!==null;
    const rows=this.db.prepare(
      'SELECT * FROM messages WHERE session_id=?'
      + (older?' AND (created_at<? OR (created_at=? AND id<?))':'')
      +' ORDER BY created_at DESC,id DESC LIMIT ?'
    ).all(...(older?[sessionId,Number(beforeTime),Number(beforeTime),String(beforeId),n+1]:[sessionId,n+1]));
    return {messages:rows.slice(0,n).reverse(),hasMore:rows.length>n};
  }
  requestHistory(sessionId,{force=false}={}) {
    if(!this.sessionById(sessionId))throw new Error('Unknown session');
    const existing=this.db.prepare('SELECT * FROM history_requests WHERE session_id=?').get(sessionId);
    if(!existing) this.db.prepare("INSERT INTO history_requests(session_id,state,updated_at) VALUES (?,'queued',?)").run(sessionId,Date.now());
    else if(force || (existing.state==='complete'&&Date.now()-existing.updated_at>60000)||existing.state==='error')
      this.db.prepare("UPDATE history_requests SET state='queued',error=NULL,updated_at=? WHERE session_id=?").run(Date.now(),sessionId);
    return this.db.prepare('SELECT * FROM history_requests WHERE session_id=?').get(sessionId);
  }
  historyStatus(sessionId) {return this.db.prepare('SELECT * FROM history_requests WHERE session_id=?').get(sessionId)||null;}
  claimHistory(host,now=Date.now()) {
    this.db.prepare("UPDATE history_requests SET state='queued' WHERE state='loading' AND updated_at<?").run(now-300000);
    const requests=this.db.prepare(
      "SELECT h.session_id,s.runtime,s.native_id FROM history_requests h JOIN sessions s ON s.id=h.session_id WHERE s.host=? AND s.runtime='codex' AND h.state='queued' ORDER BY h.updated_at LIMIT 3"
    ).all(host);
    for(const r of requests)this.db.prepare("UPDATE history_requests SET state='loading',updated_at=? WHERE session_id=? AND state='queued'").run(now,r.session_id);
    return requests;
  }
  claimWebHistory(host,now=Date.now()) {
    this.db.prepare("UPDATE history_requests SET state='queued' WHERE state='loading' AND updated_at<?").run(now-90000);
    const rows=this.db.prepare("SELECT h.session_id,s.runtime,s.native_id,s.source_url FROM history_requests h JOIN sessions s ON s.id=h.session_id WHERE s.host=? AND s.runtime IN ('chatgpt-web','codex-web','deepseek-web') AND h.state='queued' ORDER BY h.updated_at LIMIT 2").all(host);
    for(const row of rows)this.db.prepare("UPDATE history_requests SET state='loading',updated_at=? WHERE session_id=? AND state='queued'").run(now,row.session_id);
    return rows;
  }
  completeHistory(sessionId,error=null) {
    this.db.prepare('UPDATE history_requests SET state=?,error=?,updated_at=? WHERE session_id=?').run(error?'error':'complete',error,Date.now(),sessionId);
  }
  readMessages(ids) {const stmt=this.db.prepare('UPDATE messages SET read_at=?,notified_at=COALESCE(notified_at,?) WHERE id=?');for(const id of ids)stmt.run(Date.now(),Date.now(),id);}
  requestCodexSession({id,host='local',title='新会话',cwd=''}){
    if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(id)||typeof host!=='string'||!/^[a-zA-Z0-9._-]{1,60}$/.test(host))throw new Error('Invalid Codex creation request');
    if(typeof title!=='string'||title.length>160||typeof cwd!=='string'||cwd.length>2048||cwd.includes('\0'))throw new Error('Invalid Codex name or directory');
    const previous=this.creationStatus(id);
    if(previous){
      if(previous.host!==host||previous.title!==(title.trim()||'新会话')||previous.cwd!==cwd.trim())throw new Error('Creation request already used');
      return previous;
    }
    const now=Date.now();
    this.db.prepare('INSERT INTO session_creations(id,host,title,cwd,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id,host,title.trim()||'新会话',cwd.trim(),now,now);
    return this.creationStatus(id);
  }
  creationStatus(id){return this.db.prepare('SELECT * FROM session_creations WHERE id=?').get(id)||null;}
  claimSessionCreations(host){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const rows=this.db.prepare("SELECT * FROM session_creations WHERE host=? AND state='queued' ORDER BY created_at LIMIT 1").all(host);
      for(const row of rows)this.db.prepare("UPDATE session_creations SET state='creating',updated_at=? WHERE id=? AND state='queued'").run(Date.now(),row.id);
      this.db.exec('COMMIT');return rows;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  finishSessionCreation(host,result){
    const request=this.creationStatus(result.id);
    if(!request||request.host!==host)throw new Error('Unknown creation request for connector');
    if(['complete','failed'].includes(request.state))return request;
    if(request.state!=='creating')throw new Error('Creation request not claimed');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(result.error){
        this.db.prepare("UPDATE session_creations SET state='failed',error=?,updated_at=? WHERE id=?").run(String(result.error).slice(0,300),Date.now(),request.id);
      }else{
        if(typeof result.nativeId!=='string'||!result.nativeId||result.nativeId.length>250)throw new Error('Codex did not return a thread ID');
        const sessionId=this.session({runtime:'codex',host,nativeId:result.nativeId,title:request.title,cwd:result.cwd||request.cwd,activityAt:Date.now()});
        this.db.prepare("UPDATE session_creations SET state='complete',session_id=?,updated_at=? WHERE id=?").run(sessionId,Date.now(),request.id);
      }
      this.db.exec('COMMIT');return this.creationStatus(request.id);
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  queueReply(sessionId,text,id=randomUUID()) {
    if(!this.sessionById(sessionId)) throw new Error('Unknown session');
    if(!String(text||'').trim()||text.length>10000) throw new Error('Invalid reply');
    const now=Date.now();this.db.prepare('INSERT OR IGNORE INTO replies(id,session_id,text,created_at,updated_at) VALUES (?,?,?,?,?)').run(id,sessionId,text,now,now);
    return this.db.prepare('SELECT * FROM replies WHERE id=?').get(id);
  }
  queueImageReply(sessionId,text,image,id=randomUUID()){
    const session=this.sessionById(sessionId);
    if(!session||!['codex','dsh','chatgpt-web','codex-web','deepseek-web'].includes(session.runtime))
      throw new Error('Unknown or unsupported image conversation');
    if(typeof text!=='string'||text.length>10000)throw new Error('Invalid reply text');
    if(!image||!['image/png','image/jpeg','image/webp'].includes(image.type)||typeof image.data!=='string')
      throw new Error('Only PNG, JPEG and WebP images are supported');
    if(image.data.length>4_300_000||!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data))throw new Error('Image too large or invalid');
    const bytes=Buffer.from(image.data,'base64');
    if(!bytes.length||bytes.length>3_000_000)throw new Error('Image must be 3MB or smaller');
    const valid=image.type==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
      image.type==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:
      bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
    if(!valid)throw new Error('Image signature does not match the selected type');
    const previous=this.db.prepare('SELECT * FROM replies WHERE id=?').get(id);
    if(previous)return previous;
    const attachmentId=randomUUID(), now=Date.now();
    this.db.exec('BEGIN');
    try{
      this.db.prepare('INSERT INTO attachments(id,session_id,mime,name,bytes,created_at) VALUES (?,?,?,?,?,?)')
        .run(attachmentId,sessionId,image.type,String(image.name||'image').slice(0,120),bytes,now);
      this.db.prepare('INSERT INTO replies(id,session_id,text,created_at,updated_at,attachment_id) VALUES (?,?,?,?,?,?)')
        .run(id,sessionId,text,now,now,attachmentId);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return this.db.prepare('SELECT * FROM replies WHERE id=?').get(id);
  }
  replyImage(replyId,host){
    const row=this.db.prepare("SELECT r.id,r.state,a.mime,a.name,a.bytes FROM replies r JOIN sessions s ON s.id=r.session_id JOIN attachments a ON a.id=r.attachment_id WHERE r.id=? AND s.host=?").get(replyId,host);
    if(!row||row.state!=='sending')throw new Error('Image unavailable for this job');
    return {type:row.mime,name:row.name,data:Buffer.from(row.bytes).toString('base64')};
  }
  queueApproval(messageId,decision){
    if(!['accept','decline'].includes(decision))throw new Error('Invalid approval decision');
    const m=this.db.prepare("SELECT * FROM messages WHERE id=? AND kind='approval' AND external_id LIKE 'approval:%'").get(messageId);
    if(!m)throw new Error('Unknown pending approval');
    const id='approval:'+messageId,now=Date.now();
    this.db.prepare("INSERT OR IGNORE INTO replies(id,session_id,text,created_at,updated_at,kind,approval_key) VALUES (?,?,?,?,?,'approval',?)").run(id,m.session_id,decision,now,now,m.external_id.slice('approval:'.length));
    this.readMessages([messageId]);
    return this.db.prepare('SELECT * FROM replies WHERE id=?').get(id);
  }
  claimReplies(host,now=Date.now()) {
    this.db.prepare("UPDATE replies SET state='queued' WHERE state='sending' AND claim_until<?").run(now);
    const rows=this.db.prepare("SELECT r.*,s.native_id,s.runtime FROM replies r JOIN sessions s ON s.id=r.session_id WHERE s.host=? AND r.state='queued' ORDER BY r.created_at LIMIT 20").all(host);
    for(const r of rows) this.db.prepare("UPDATE replies SET state='sending',claim_until=?,updated_at=? WHERE id=? AND state='queued'").run(now+60000,now,r.id);
    return rows;
  }
  replyState(id,state,error=null) {
    if(!['sent','failed','queued'].includes(state)) throw new Error('Bad reply state');
    const r=this.db.prepare('SELECT * FROM replies WHERE id=?').get(id);
    if(!r) throw new Error('Unknown reply');
    this.db.prepare('UPDATE replies SET state=?,error=?,updated_at=?,claim_until=NULL WHERE id=?').run(state,error,Date.now(),id);
    if(state==='sent'&&r.kind!=='approval'){
      if(!r.message_id){
        const message=this.message({sessionId:r.session_id,externalId:'reply:'+id,role:'user',body:r.text||(r.attachment_id?'[图片]':'')});
        if(message)this.db.prepare('UPDATE replies SET message_id=? WHERE id=?').run(message.id,id);
      }
      if(r.attachment_id)this.db.prepare('DELETE FROM attachments WHERE id=?').run(r.attachment_id);
    }
  }
  replies(sessionId){return this.db.prepare('SELECT * FROM replies WHERE session_id=? ORDER BY created_at DESC LIMIT 50').all(sessionId);}
  pendingBatchAnchor(){
    const row=this.db.prepare(`SELECT MIN(started_at) first_at FROM (
      SELECT COALESCE(r.started_at,m.queued_at) started_at FROM messages m
      LEFT JOIN run_starts r ON r.session_id=m.session_id AND r.run_id=m.run_id
      WHERE m.role='agent' AND m.priority='normal' AND m.notified_at IS NULL AND m.queued_at>0
      UNION ALL SELECT r.started_at FROM run_starts r JOIN sessions s ON s.id=r.session_id
      WHERE (?=0 OR s.instant_mode=0) AND NOT EXISTS (
        SELECT 1 FROM run_completions c WHERE c.session_id=r.session_id AND c.run_id=r.run_id)
    )`).get(this.setting('instantEnabled')?1:0);
    return row.first_at||null;
  }
  pendingCompletionAt(){return this.db.prepare("SELECT MIN(queued_at) at FROM messages WHERE role='agent' AND priority='normal' AND notified_at IS NULL AND queued_at>0").get().at||null;}
  pendingNotifications(){return this.db.prepare("SELECT m.*,s.title,s.runtime,s.host FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.role='agent' AND m.priority='normal' AND m.notified_at IS NULL AND m.queued_at>0 ORDER BY m.queued_at,m.created_at").all();}
  claimNotificationBatch(now=Date.now(),cutoff=Infinity) {
    const pending=this.pendingNotifications().filter(m=>m.queued_at<=cutoff);if(!pending.length)return[];
    const stmt=this.db.prepare('UPDATE messages SET notified_at=? WHERE id=? AND notified_at IS NULL');
    for(const m of pending){
      if(m.run_id)this.db.prepare("UPDATE messages SET notified_at=? WHERE session_id=? AND run_id=? AND role='agent' AND notified_at IS NULL").run(now,m.session_id,m.run_id);
      else stmt.run(now,m.id);
    }
    return pending;
  }
  markInstantNotified(id,now=Date.now()){this.db.prepare('UPDATE messages SET notified_at=? WHERE id=?').run(now,id);}
  lastBatchAt(){return Number(this.setting('__lastBatchAt')||0);}
  noteBatch(time){this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('__lastBatchAt',JSON.stringify(time));}
  saveSubscription(subscription,name='Device') {
    if(!subscription?.endpoint||!subscription?.keys?.p256dh||!subscription?.keys?.auth)throw new Error('Invalid push subscription');
    this.db.prepare('INSERT OR REPLACE INTO subscriptions VALUES (?,?,?,?)').run(subscription.endpoint,JSON.stringify(subscription),String(name).slice(0,80),Date.now());
  }
  subscriptions(){return this.db.prepare('SELECT * FROM subscriptions').all();}
  removeSubscription(endpoint){this.db.prepare('DELETE FROM subscriptions WHERE endpoint=?').run(endpoint);}
}
