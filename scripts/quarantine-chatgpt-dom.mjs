/* One-time recovery for legacy ChatGPT DOM cross-conversation contamination.
 * Save all imported rows, then remove them from live conversation timelines.
 * Native Codex/DSH/DeepSeek data and user replies are intentionally untouched.
 * After reloading extension 0.3.1+ and revisiting real ChatGPT pages,
 * correct history will be silently imported again.
 */
import { DatabaseSync, backup } from 'node:sqlite';
import { resolve,dirname,join } from 'node:path';
import { mkdirSync,existsSync } from 'node:fs';

const dbPath=resolve(process.env.ATTNWALL_DB||'.data/attnwall.db');
if(!existsSync(dbPath))throw new Error('AttnWall DB not found: '+dbPath);
const backupDir=join(dirname(dbPath),'backups');mkdirSync(backupDir,{recursive:true});
const filename='attnwall-before-chatgpt-quarantine-'+new Date().toISOString().replace(/[:.]/g,'-')+'.db';
const backupPath=join(backupDir,filename);
const source=new DatabaseSync(dbPath,{readOnly:true});
try{await backup(source,backupPath);}finally{source.close();}
const db=new DatabaseSync(dbPath);
const table='quarantined_chatgpt_dom_20261023';
try{
  db.exec('PRAGMA busy_timeout=6000');
  db.exec('BEGIN IMMEDIATE');
  try{
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} AS
      SELECT m.*,s.title AS source_title,s.source_url AS source_url,0 AS quarantined_at
      FROM messages m JOIN sessions s ON s.id=m.session_id WHERE 0`);
    const initial=db.prepare("SELECT COUNT(*) count FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.runtime='chatgpt-web' AND m.external_id LIKE 'dom-%'").get().count;
    const copied=db.prepare(`INSERT INTO ${table}
      SELECT m.*,s.title,s.source_url,?
      FROM messages m JOIN sessions s ON s.id=m.session_id
      WHERE s.runtime='chatgpt-web' AND m.external_id LIKE 'dom-%'
      AND NOT EXISTS (SELECT 1 FROM ${table} q WHERE q.id=m.id)`).run(Date.now()).changes;
    const cleared=db.prepare(`DELETE FROM messages WHERE id IN (SELECT id FROM ${table}) AND
      session_id IN (SELECT id FROM sessions WHERE runtime='chatgpt-web')
      AND external_id LIKE 'dom-%'`).run().changes;
    if(cleared!==initial)throw new Error('Quarantine row count mismatch '+cleared+' != '+initial);
    db.exec('COMMIT');
    console.log(JSON.stringify({backup:backupPath,quarantinedTable:table,originalDomCount:initial,newlySaved:copied,removedFromLiveView:cleared,preservedOtherRuntime:true,preservedOutgoingReplies:true}));
  }catch(e){db.exec('ROLLBACK');throw e;}
}finally{db.close();}
