import {randomUUID} from 'node:crypto';
import {mkdir,lstat,realpath,rename,rm,readFile,readdir} from 'node:fs/promises';
import {isAbsolute,resolve,join,sep} from 'node:path';
import {AuthError} from '../auth/service.mjs';
import {identifier} from '../catalog/service.mjs';
import {metadata,snapshot,validateArchive,safeRead,atomicJson,restoreRows} from './archive.mjs';
const exists=async path=>{try{return await lstat(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const errorCode=e=>e instanceof AuthError?e.code:['ENOSPC','EDQUOT'].includes(e.code)?'SPACE_FULL':e.code==='ENOENT'?'PATH_UNAVAILABLE':['EACCES','EPERM','EROFS'].includes(e.code)?'PATH_PERMISSION':e.message==='UNSAFE_FILE'?'UNSAFE_FILE':'BACKUP_FAILED';
export function scheduledDay(now=new Date()){
 const local=new Date(now.getTime()+8*3600000);if(local.getUTCHours()<2)local.setUTCDate(local.getUTCDate()-1);return local.toISOString().slice(0,10);
}
export class BackupService{
 constructor(pool,auth,dataDir,{fault,now=()=>new Date()}={}){this.pool=pool;this.auth=auth;this.dataDir=resolve(dataDir);this.work=join(this.dataDir,'backup-work');this.fault=fault;this.now=now;this.lastAutoAttempt=0;this.active=new Set();}
 async ready(){await mkdir(this.work,{recursive:true,mode:0o700});await mkdir(join(this.work,'uploads'),{recursive:true,mode:0o700});}
 async exclusive(fn){const operation=(async()=>{await this.ready();const db=await this.pool.connect();try{await db.query('SELECT pg_advisory_lock(20261132)');return await fn(db);}finally{await db.query('SELECT pg_advisory_unlock(20261132)');db.release();}})();this.active.add(operation);try{return await operation;}finally{this.active.delete(operation);}}
 async waitForIdle(){while(this.active.size)await Promise.allSettled([...this.active]);}
 async check(db,raw,csrf,write=true){await db.query('BEGIN');try{const a=await this.auth.authorizeIn(db,raw,{admin:true,write,csrf,backupControl:true});await db.query('COMMIT');return a;}catch(e){await db.query('ROLLBACK');throw e;}}
 async settings(){return (await this.pool.query('SELECT * FROM backup_config WHERE id=1')).rows[0];}
 async configure(raw,csrf,input){return this.exclusive(async db=>{await this.check(db,raw,csrf);const disabled=input.path1===''&&input.path2==='';const paths=disabled?[null,null]:[input.path1,input.path2];for(const path of disabled?[]:paths){if(typeof path!=='string'||path.length>1024||!isAbsolute(path)||/[\u0000-\u001f]/.test(path)||resolve(path)===this.dataDir||resolve(path).startsWith(this.dataDir+sep))throw new AuthError('INVALID_BACKUP_PATH');}if(!disabled&&resolve(paths[0])===resolve(paths[1]))throw new AuthError('DISTINCT_BACKUP_PATHS_REQUIRED');const limit=Number(input.uploadLimit??8589934592);if(!Number.isSafeInteger(limit)||limit<1048576||limit>1099511627776)throw new AuthError('INVALID_UPLOAD_LIMIT');const changed=await db.query('UPDATE backup_config SET path1=$1,path2=$2,upload_limit=$3,warning=CASE WHEN $1::text IS NULL THEN NULL ELSE warning END,revision=revision+1 WHERE id=1 AND ($4::bigint IS NULL OR revision=$4) RETURNING revision',[...paths.map(path=>path===null?null:resolve(path)),limit,input.expectedRevision??null]);if(!changed.rows.length)throw new AuthError('BACKUP_CONFIG_VERSION_CONFLICT',409);return {configured:true};});}
 async directory(path){if(!path)throw Object.assign(Error('Path unavailable'),{code:'ENOENT'});const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(path)!==resolve(path))throw Object.assign(Error('Unsafe directory'),{code:'EACCES'});return path;}
 async create(raw,csrf,kind='manual'){if(kind!=='manual')throw new AuthError('INVALID_BACKUP_KIND');return this.exclusive(async db=>{await this.check(db,raw,csrf);return this.perform(db,kind);});}
 async downloadFull(raw,send){
  await this.auth.authorize(raw,{admin:true,backupControl:true});
  return this.exclusive(async db=>{
   await this.check(db,raw,undefined,false);
   const id=randomUUID(),path=join(this.work,'download-'+id+'.partial');
   const adapter={connect:async()=>({query:db.query.bind(db),release(){}})};
   let handle;
   try{
    const config=(await db.query('SELECT upload_limit FROM backup_config WHERE id=1')).rows[0];
    const info=await snapshot(adapter,path,this.dataDir);
    const checked=await validateArchive(path,await metadata(db),{limit:Number(config.upload_limit)});
    if(checked.sha256!==info.sha256||checked.bytes!==info.bytes)throw new AuthError('BACKUP_CHECKSUM');
    handle=await safeRead(path);
    await send({handle,bytes:info.bytes,filename:`warehouse-${id}.whb`});
   }finally{
    try{if(handle)await handle.close();}finally{await rm(path,{force:true});}
   }
  });
 }
 async perform(db,kind){
  const config=(await db.query('SELECT * FROM backup_config WHERE id=1')).rows[0],errors=[];
  const internal=kind==='pre_restore'&&!config.path1&&!config.path2;
  const paths=internal?[this.work]:[config.path1,config.path2];
  for(const [index,path]of paths.entries()){
   const id=randomUUID();let partial,final;
   try{
    await this.directory(path);partial=join(path,id+'.partial');final=join(path,id+'.whb');if(this.fault)await this.fault({phase:'write',index,path,kind});
    const adapter={connect:async()=>({query:db.query.bind(db),release(){}})};
    const info=await snapshot(adapter,partial,this.dataDir,{onSnapshot:this.fault?()=>this.fault({phase:'snapshot',index,path,kind}):undefined});await validateArchive(partial,await metadata(db),{limit:Number(config.upload_limit)});
    await rename(partial,final);await db.query('INSERT INTO backup_runs(id,kind,snapshot_at,path,bytes,sha256,verified) VALUES($1,$2,$3,$4,$5,$6,true)',[id,kind,info.snapshotAt,final,info.bytes,info.sha256]);
    await db.query('UPDATE backup_config SET warning=NULL WHERE id=1');await db.query('UPDATE system_settings SET admin_backup_required=false WHERE id=1');return {id,kind,path:index+1,...info,verified:true};
   }catch(e){errors.push({path:index+1,error:errorCode(e)});if(partial)await rm(partial,{force:true}).catch(()=>{});if(final)await rm(final,{force:true}).catch(()=>{});}
  }
  await db.query('UPDATE backup_config SET warning=$1::jsonb WHERE id=1',[JSON.stringify({at:this.now().toISOString(),errors})]);
  if(!internal&&errors.every(e=>e.error==='SPACE_FULL'))await db.query('UPDATE system_settings SET admin_backup_required=true WHERE id=1');
  throw new AuthError('BACKUP_FAILED',503);
 }
 async list(raw){await this.auth.authorize(raw,{admin:true,backupControl:true});const config=await this.settings();const state=(await this.pool.query('SELECT maintenance,admin_backup_required FROM system_settings WHERE id=1')).rows[0];const backups=(await this.pool.query('SELECT * FROM backup_runs ORDER BY created_at DESC,id')).rows;for(const r of backups){const stat=await exists(r.path);r.missing=!stat?.isFile()||stat.isSymbolicLink();r.bytes=Number(r.bytes);}return {config:{revision:String(config.revision),path1:config.path1,path2:config.path2,uploadLimit:Number(config.upload_limit),warning:config.warning,lastAutoDay:config.last_auto_day},state,backups};}
 async validRun(db,id){identifier(id);const r=(await db.query('SELECT * FROM backup_runs WHERE id=$1',[id])).rows[0];if(!r)throw new AuthError('BACKUP_NOT_FOUND',404);const verified=await validateArchive(r.path,await metadata(db));if(verified.sha256!==r.sha256||verified.bytes!==Number(r.bytes))throw new AuthError('BACKUP_CHECKSUM');return r;}
 async download(raw,id){await this.auth.authorize(raw,{admin:true,backupControl:true});return this.exclusive(async db=>{const r=await this.validRun(db,id);return {handle:await safeRead(r.path),bytes:Number(r.bytes),filename:`warehouse-${r.id}.whb`};});}
 async delete(raw,csrf,id){return this.exclusive(async db=>{await this.check(db,raw,csrf);await this.remove(db,id);return {deleted:true};});}
 async remove(db,id){identifier(id);const runs=(await db.query('SELECT * FROM backup_runs ORDER BY created_at DESC,id')).rows,target=runs.find(r=>r.id===id);if(!target)throw new AuthError('BACKUP_NOT_FOUND',404);let alternative=false;
  for(const r of runs.filter(r=>r.id!==id)){try{await this.validRun(db,r.id);alternative=true;break;}catch{}}
  if(!alternative){try{await this.validRun(db,id);throw new AuthError('LAST_VALID_BACKUP',409);}catch(e){if(e.code==='LAST_VALID_BACKUP')throw e;}}
  const stat=await exists(target.path);if(stat?.isSymbolicLink()||stat&&!stat.isFile())throw new AuthError('UNSAFE_BACKUP_PATH');if(stat)await rm(target.path);await db.query('DELETE FROM backup_runs WHERE id=$1',[id]);
 }
 async retention(db){const runs=(await db.query("SELECT id FROM backup_runs WHERE kind='automatic' AND created_at<clock_timestamp()-INTERVAL '30 days' ORDER BY created_at,id")).rows;for(const run of runs){try{await this.remove(db,run.id);}catch(e){if(e.code!=='LAST_VALID_BACKUP')throw e;}}}
 async scheduled(){const now=this.now();if(now.getTime()-this.lastAutoAttempt<15*60000)return {due:false};return this.exclusive(async db=>{const config=(await db.query('SELECT path1,last_auto_day::text AS last_auto_day FROM backup_config WHERE id=1')).rows[0],day=scheduledDay(now),last=config.last_auto_day;if(!config.path1||last===day)return {due:false};this.lastAutoAttempt=now.getTime();const result=await this.perform(db,'automatic');await db.query('UPDATE backup_config SET last_auto_day=$1 WHERE id=1',[day]);await this.retention(db);return {due:true,...result};});}
 async upload(raw,csrf,source){return this.exclusive(async db=>{await this.check(db,raw,csrf);const config=(await db.query('SELECT upload_limit FROM backup_config WHERE id=1')).rows[0],limit=Number(config.upload_limit),id=randomUUID(),path=join(this.work,'uploads',id+'.partial');let handle;
  try{const {open}=await import('node:fs/promises');handle=await open(path,'wx',0o600);let bytes=0;for await(const chunk of source){bytes+=chunk.length;if(bytes>limit)throw new AuthError('BACKUP_TOO_LARGE',413);await handle.writeFile(chunk);}await handle.sync();await handle.close();handle=null;
   const info=await validateArchive(path,await metadata(db),{limit});await rename(path,join(this.work,'uploads',id+'.whb'));await db.query('INSERT INTO backup_uploads(id,bytes,sha256,snapshot_at) VALUES($1,$2,$3,$4)',[id,info.bytes,info.sha256,info.header.snapshotAt]);return {id,bytes:info.bytes,snapshotAt:info.header.snapshotAt,verified:true};
  }catch(e){if(handle)await handle.close();await rm(path,{force:true});throw e;}
 });}
 async maintenance(raw,csrf,enabled){if(typeof enabled!=='boolean')throw new AuthError('INVALID_MAINTENANCE');return this.exclusive(async db=>{await db.query('BEGIN');try{await db.query('SELECT id FROM system_settings WHERE id=1 FOR UPDATE');await this.auth.authorizeIn(db,raw,{admin:true,write:true,csrf,backupControl:true});await db.query('UPDATE system_settings SET maintenance=$1 WHERE id=1',[enabled]);if(enabled)await db.query("UPDATE count_tasks SET run_generation=run_generation+1 WHERE status='active'");await db.query('COMMIT');return {maintenance:enabled};}catch(e){await db.query('ROLLBACK');throw e;}});}
 async recoverJournal(db){
  const path=join(this.work,'restore-journal.json');if(!await exists(path))return;
  const journal=JSON.parse(await readFile(path,'utf8'));identifier(journal.id);const marker=(await db.query('SELECT restore_marker FROM system_settings WHERE id=1')).rows[0].restore_marker;
  for(const kind of ['product-photos','avatars']){const live=join(this.dataDir,kind),old=join(this.dataDir,`.restore-${journal.id}-${kind}`);if(marker===journal.id){await rm(old,{recursive:true,force:true});}else if(await exists(old)){await rm(live,{recursive:true,force:true});await rename(old,live);}else if(!journal.hadOld[kind])await rm(live,{recursive:true,force:true});}
  await rm(join(this.work,'restore-'+journal.id),{recursive:true,force:true});await rm(path);
  // A crash before database commit leaves maintenance on; administrator reviews the preserved scene.
  if(marker===journal.id)await db.query('UPDATE system_settings SET maintenance=false WHERE id=1');
 }
 async startup(){return this.exclusive(async db=>{
  await this.recoverJournal(db);
  for(const name of await readdir(this.work)){
   if(/^download-[a-f0-9-]{36}\.partial$/.test(name))await rm(join(this.work,name),{force:true});
  }
  const invalid=(await db.query("SELECT i.indexrelid FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=current_schema() AND NOT i.indisvalid")).rows;
  if(invalid.length){await db.query('UPDATE system_settings SET maintenance=true WHERE id=1');throw Error('DATABASE_INTEGRITY_REQUIRES_RECOVERY');}
  // A product without its transactional mandatory balance is the only verified auto-recovery signal.
  // Empty tables, lawful deletions, and connection failure never trigger restore.
  const broken=(await db.query('SELECT p.id FROM products p LEFT JOIN inventory_balances b ON b.product_id=p.id WHERE b.product_id IS NULL LIMIT 1')).rows;
  if(!broken.length)return {recovered:false};
  await db.query('UPDATE system_settings SET maintenance=true WHERE id=1');
  const scene=join(this.work,'incident-'+randomUUID()+'.whb');
  const adapter={connect:async()=>({query:db.query.bind(db),release(){}})};
  await snapshot(adapter,scene,this.dataDir); // Preserve before attempting any destructive recovery.
  const runs=(await db.query('SELECT id FROM backup_runs ORDER BY snapshot_at DESC,created_at DESC,id')).rows;let selected;
  for(const run of runs){try{await this.validRun(db,run.id);selected=run.id;break;}catch{}}
  if(!selected)throw Error('NO_VALID_BACKUP_STOPPED_WRITES');
  await this.restoreIn(db,{id:selected,scene});
  await db.query('UPDATE backup_config SET warning=$1::jsonb WHERE id=1',[JSON.stringify({code:'AUTOMATIC_RECOVERY',at:this.now().toISOString(),backupId:selected})]);return {recovered:true};
 });}
 async restore(raw,csrf,{id,uploaded=false,confirm}){
  if(confirm!=='restore-entire-system')throw new AuthError('RESTORE_CONFIRMATION_REQUIRED',409);identifier(id);
  return this.exclusive(async db=>{await this.check(db,raw,csrf);return this.restoreIn(db,{id,uploaded});});
 }
 async restoreIn(db,{id,uploaded=false,scene}){
   const config=(await db.query('SELECT upload_limit FROM backup_config WHERE id=1')).rows[0],limit=Number(config.upload_limit),meta=await metadata(db);let source,expected;
   if(uploaded){const upload=(await db.query('SELECT * FROM backup_uploads WHERE id=$1',[id])).rows[0];if(!upload)throw new AuthError('UPLOAD_NOT_FOUND',404);source=join(this.work,'uploads',id+'.whb');expected=upload.sha256;}else{const r=await this.validRun(db,id);source=r.path;expected=r.sha256;}
   const op=randomUUID(),stage=join(this.work,'restore-'+op),assets=join(stage,'assets');await mkdir(assets,{recursive:true,mode:0o700});
   try{
    const checked=await validateArchive(source,meta,{limit,stageDir:assets});if(checked.sha256!==expected)throw new AuthError('BACKUP_CHECKSUM');
    // Setting lock waits for in-flight guarded writes, then blocks all later writes.
    await db.query('UPDATE system_settings SET maintenance=true WHERE id=1');
    const preserved=scene?{id:null}:await this.perform(db,'pre_restore');
    const journal={id:op,hadOld:{},preservedBackupId:preserved.id};for(const kind of ['product-photos','avatars'])journal.hadOld[kind]=!!await exists(join(this.dataDir,kind));
    await atomicJson(join(this.work,'restore-journal.json'),journal);
    const originalSequences=[];for(const name of meta.sequences){const row=(await db.query(`SELECT last_value,is_called FROM "${name}"`)).rows[0];originalSequences.push({name,...row});}
    await db.query('BEGIN');try{
     await db.query('SELECT id FROM system_settings WHERE id=1 FOR UPDATE');
     await restoreRows(db,source,meta,limit);
     await db.query('DELETE FROM sessions');await db.query('UPDATE users SET session_generation=session_generation+1');await db.query("UPDATE count_tasks SET run_generation=run_generation+1 WHERE status='active'");
     for(const kind of ['product-photos','avatars']){const live=join(this.dataDir,kind),old=join(this.dataDir,`.restore-${op}-${kind}`);if(journal.hadOld[kind])await rename(live,old);await mkdir(join(assets,kind),{recursive:true,mode:0o700});await rename(join(assets,kind),live);}
     if(this.fault)await this.fault({phase:'restore-before-commit'});
     for(const s of checked.header.sequences)await db.query('SELECT setval($1::regclass,$2,$3)',[s.name,s.last_value,s.is_called]);
     await db.query('UPDATE system_settings SET restore_marker=$1,maintenance=true,admin_backup_required=CASE WHEN $2::boolean THEN admin_backup_required ELSE false END WHERE id=1',[op,!!scene]);
     await db.query('COMMIT');
    }catch(e){await db.query('ROLLBACK');for(const s of originalSequences)await db.query('SELECT setval($1::regclass,$2,$3)',[s.name,s.last_value,s.is_called]);await this.recoverJournal(db);throw e;}
    await this.recoverJournal(db);return {restored:true,requiresLogin:true,preservedBackupId:preserved.id};
   }catch(e){await rm(stage,{recursive:true,force:true});throw e;}
 }
 async cleanUploads(raw,csrf){return this.exclusive(async db=>{await this.check(db,raw,csrf);const files=await readdir(join(this.work,'uploads'));for(const name of files){if(/^[a-f\d-]{36}\.(whb|partial)$/.test(name))await rm(join(this.work,'uploads',name),{force:true});}await db.query('DELETE FROM backup_uploads');return {cleared:true};});}
}
