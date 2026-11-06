import {createHash,randomUUID} from 'node:crypto';
import {open,mkdir,lstat,realpath,rename,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,sep} from 'node:path';
import {AuthError} from '../auth/service.mjs';
const exclude=new Set(['schema_migrations','sessions','system_settings','backup_config','backup_runs','backup_uploads','export_jobs','export_resources','export_history_resources','export_report_resources','employee_pairing_invites','employee_device_bindings','employee_pairing_audit']);
const quote=name=>'"'+name.replaceAll('"','""')+'"';
const hash=()=>createHash('sha256');
export const validAsset=key=>typeof key==='string'&&/^(product-photos|avatars)\/[a-f\d-]{36}\.(png|jpg)$/.test(key);
export async function safeRead(path,{limit=Infinity}={}){
 const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)throw Error('UNSAFE_FILE');
 const h=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));return h;
}
export async function fileHash(path){const h=hash();let bytes=0;const handle=await safeRead(path);try{for await(const chunk of handle.createReadStream({autoClose:false})){h.update(chunk);bytes+=chunk.length;}}finally{await handle.close();}return {sha256:h.digest('hex'),bytes};}
export async function metadata(db){
 const tables=(await db.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() ORDER BY table_name,ordinal_position")).rows;
 const map=new Map();for(const r of tables)if(!exclude.has(r.table_name)){if(!/^[a-z][a-z0-9_]*$/.test(r.table_name))throw Error('UNSUPPORTED_TABLE');if(!map.has(r.table_name))map.set(r.table_name,[]);map.get(r.table_name).push(r.column_name);}
 const fks=(await db.query("SELECT a.relname AS child,b.relname AS parent FROM pg_constraint c JOIN pg_class a ON a.oid=c.conrelid JOIN pg_class b ON b.oid=c.confrelid JOIN pg_namespace n ON n.oid=a.relnamespace WHERE c.contype='f' AND n.nspname=current_schema() AND a.oid<>b.oid")).rows;
 const ordered=[];while(map.size){const ready=[...map.keys()].filter(table=>!fks.some(f=>f.child===table&&map.has(f.parent))).sort();if(!ready.length)throw Error('CYCLIC_SCHEMA');for(const name of ready){ordered.push({name,columns:map.get(name)});map.delete(name);}}
 const migrations=(await db.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows;
 const sequences=(await db.query('SELECT sequencename FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename')).rows.map(r=>r.sequencename);
 return {tables:ordered,migrations,sequences};
}
export async function snapshot(pool,target,dataDir,{onSnapshot}={}){
 const db=await pool.connect();let handle,started=false,locked=false;const digest=hash(),assets=new Set();
 try{
  // Session lock is acquired BEFORE the snapshot. Photo updates/deletion share this lock.
  await db.query('SELECT pg_advisory_lock(20261131)');locked=true;
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');started=true;
  const meta=await metadata(db),snapshotAt=(await db.query('SELECT transaction_timestamp() AS now')).rows[0].now;
  const sequences=[];for(const name of meta.sequences){const row=(await db.query(`SELECT last_value,is_called FROM ${quote(name)}`)).rows[0];sequences.push({name,...row});}
  handle=await open(target,'wx',0o600);let lines=0;
  const write=async row=>{const s=JSON.stringify(row)+'\n';digest.update(s);await handle.writeFile(s);lines++;};
  await write({type:'header',format:'TATLEE-WAREHOUSE',version:1,snapshotAt,meta,sequences,configuration:{timezone:'Asia/Kuala_Lumpur',paths:'Configure new server paths; secrets and TLS keys are not included.'}});
  for(const table of meta.tables){
   let offset=0;while(true){const rows=(await db.query(`SELECT ${table.columns.map(quote).join(',')} FROM ${quote(table.name)} ORDER BY ${table.columns.map(quote).join(',')} LIMIT 500 OFFSET $1`,[offset])).rows;
    for(const row of rows){const values=table.columns.map(c=>row[c]);await write({type:'row',table:table.name,values});if(table.name==='products'&&row.photo_key)assets.add('product-photos/'+row.photo_key);if(table.name==='users'&&row.avatar_key)assets.add('avatars/'+row.avatar_key);}
    if(rows.length<500)break;offset+=rows.length;
   }
  }
  if(onSnapshot)await onSnapshot();
  for(const key of [...assets].sort()){
   if(!validAsset(key))throw Error('UNSAFE_ASSET');const root=await realpath(dataDir),path=resolve(root,key),actual=await realpath(path);if(!actual.startsWith(root+sep))throw Error('UNSAFE_ASSET');
   const file=await safeRead(path,{limit:5*1024*1024}),stat=await file.stat(),sum=hash();await write({type:'file',key,bytes:stat.size});
   try{for await(const chunk of file.createReadStream({autoClose:false,highWaterMark:48*1024})){sum.update(chunk);await write({type:'chunk',data:chunk.toString('base64')});}}finally{await file.close();}
   await write({type:'endfile',sha256:sum.digest('hex')});
  }
  await handle.writeFile(JSON.stringify({type:'complete',sha256:digest.digest('hex'),lines})+'\n');await handle.sync();await handle.close();handle=null;
  await db.query('COMMIT');started=false;return {snapshotAt,...await fileHash(target)};
 }catch(error){if(started)await db.query('ROLLBACK');if(handle)await handle.close();await rm(target,{force:true});throw error;}
 finally{if(locked)await db.query('SELECT pg_advisory_unlock(20261131)');db.release();}
}
async function* records(path,limit){
 let buffer=Buffer.alloc(0),total=0;const handle=await safeRead(path,{limit});
 try{for await(const chunk of handle.createReadStream({autoClose:false,highWaterMark:65536})){total+=chunk.length;if(total>limit)throw new AuthError('BACKUP_TOO_LARGE',413);buffer=Buffer.concat([buffer,chunk]);let newline;
  while((newline=buffer.indexOf(10))>=0){if(newline>1048576)throw new AuthError('BACKUP_LINE_TOO_LARGE');const line=buffer.subarray(0,newline+1);buffer=buffer.subarray(newline+1);let row;try{row=JSON.parse(line.toString('utf8'));}catch{throw new AuthError('INVALID_BACKUP');}yield {row,line};}
  if(buffer.length>1048576)throw new AuthError('BACKUP_LINE_TOO_LARGE');
 }if(buffer.length)throw new AuthError('INCOMPLETE_BACKUP');}finally{await handle.close();}
}
export async function validateArchive(path,meta,{limit=8589934592,stageDir,onRow}={}){
 let header,complete=false,lines=0,current,file,bytes=0,assetHash;const digest=hash(),assets=new Set(),expectedAssets=new Set(),counts=new Map(),productIds=new Set(),balanceIds=new Set();let administrators=0;const cleanupRequests=[];
 try{
  for await(const {row,line}of records(path,limit)){
   if(complete)throw new AuthError('INVALID_BACKUP');
   if(row.type==='complete'){if(!header||current||row.sha256!==digest.digest('hex')||row.lines!==lines)throw new AuthError('BACKUP_CHECKSUM');complete=true;continue;}
   digest.update(line);lines++;
   if(!header){if(row.type!=='header'||row.format!=='TATLEE-WAREHOUSE'||row.version!==1||!Number.isFinite(new Date(row.snapshotAt).getTime()))throw new AuthError('INVALID_BACKUP');
    // Migration 8 changes only local device/session tables excluded from archives.
    const exact=JSON.stringify(row.meta)===JSON.stringify(meta);
    const beforePairing=meta.migrations.at(-1)?.version===8&&JSON.stringify(row.meta)===JSON.stringify({...meta,migrations:meta.migrations.slice(0,-1)});
    if(!exact&&!beforePairing)throw new AuthError('BACKUP_VERSION_MISMATCH',409);
    if(!Array.isArray(row.sequences)||JSON.stringify(row.sequences.map(r=>r.name))!==JSON.stringify(meta.sequences)||row.sequences.some(r=>!/^\d+$/.test(String(r.last_value))||BigInt(r.last_value)>9223372036854775807n||typeof r.is_called!=='boolean'))throw new AuthError('INVALID_BACKUP_SEQUENCE');
    header=row;continue;
   }
   if(row.type==='row'){
    if(current||assets.size)throw new AuthError('INVALID_BACKUP_ORDER');const table=meta.tables.find(t=>t.name===row.table);if(!table||!Array.isArray(row.values)||row.values.length!==table.columns.length)throw new AuthError('INVALID_BACKUP_ROW');
    const index=meta.tables.indexOf(table);if([...counts.keys()].some(n=>meta.tables.findIndex(t=>t.name===n)>index))throw new AuthError('INVALID_BACKUP_ORDER');counts.set(row.table,(counts.get(row.table)||0)+1);
    const record=Object.fromEntries(table.columns.map((c,i)=>[c,row.values[i]]));if(row.table==='file_cleanup')cleanupRequests.push(record);if(row.table==='products')productIds.add(record.id);if(row.table==='inventory_balances')balanceIds.add(record.product_id);if(row.table==='users'&&record.role==='admin'&&record.active)administrators++;if(row.table==='products'&&record.photo_key)expectedAssets.add('product-photos/'+record.photo_key);if(row.table==='users'&&record.avatar_key)expectedAssets.add('avatars/'+record.avatar_key);
    if(onRow)await onRow(table,row.values);continue;
   }
   if(row.type==='file'){
    if(current||!validAsset(row.key)||assets.has(row.key)||!Number.isSafeInteger(row.bytes)||row.bytes<1||row.bytes>5*1024*1024)throw new AuthError('INVALID_BACKUP_ASSET');current=row;bytes=0;assetHash=hash();assets.add(row.key);
    if(stageDir){const target=resolve(stageDir,row.key);await mkdir(resolve(target,'..'),{recursive:true,mode:0o700});file=await open(target,'wx',0o600);}continue;
   }
   if(row.type==='chunk'){
    if(!current||typeof row.data!=='string'||row.data.length>65536||!row.data.length||row.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(row.data))throw new AuthError('INVALID_BACKUP_ASSET');const chunk=Buffer.from(row.data,'base64');if(chunk.toString('base64')!==row.data)throw new AuthError('INVALID_BACKUP_ASSET');bytes+=chunk.length;if(bytes>current.bytes)throw new AuthError('INVALID_BACKUP_ASSET');assetHash.update(chunk);if(file)await file.writeFile(chunk);continue;
   }
   if(row.type==='endfile'){
    if(!current||bytes!==current.bytes||row.sha256!==assetHash.digest('hex'))throw new AuthError('BACKUP_CHECKSUM');if(file){await file.sync();await file.close();file=null;}current=null;continue;
   }
   throw new AuthError('INVALID_BACKUP');
  }
  for(const record of cleanupRequests){const kind=record.asset_kind||'product',key=record.file_key;if(kind==='product'||kind==='avatar'){if(typeof key!=='string'||!/^[a-f\d-]{36}\.(jpg|png)$/.test(key)||expectedAssets.has((kind==='product'?'product-photos/':'avatars/')+key))throw new AuthError('BACKUP_CLEANUP_INVALID');}else if(kind==='export'){if(typeof key!=='string'||!/^([a-f\d-]{36})\.(pdf|xlsx|partial|spool|work)$/.test(key))throw new AuthError('BACKUP_CLEANUP_INVALID');}else throw new AuthError('BACKUP_CLEANUP_INVALID');}
  if(administrators!==1||productIds.size!==balanceIds.size||[...productIds].some(id=>!balanceIds.has(id)))throw new AuthError('BACKUP_INTEGRITY');
  if(!complete||[...expectedAssets].some(k=>!validAsset(k))||JSON.stringify([...assets].sort())!==JSON.stringify([...expectedAssets].sort()))throw new AuthError('INCOMPLETE_BACKUP');
  return {header,...await fileHash(path)};
 }finally{if(file)await file.close();}
}
export async function restoreRows(db,path,meta,limit){
 const deferred=[];
 const tables=meta.tables.map(t=>quote(t.name));await db.query(`TRUNCATE ${tables.join(',')} CASCADE`);
 await validateArchive(path,meta,{limit,onRow:async(table,values)=>{
  const copy=[...values];if(table.name==='warehouse_locations'){const parent=table.columns.indexOf('parent_id');if(copy[parent]){deferred.push([copy[table.columns.indexOf('id')],copy[parent]]);copy[parent]=null;}}
  await db.query(`INSERT INTO ${quote(table.name)}(${table.columns.map(quote).join(',')}) VALUES(${values.map((_,i)=>'$'+(i+1)).join(',')})`,copy);
 }});
 for(const [id,parent]of deferred)await db.query('UPDATE warehouse_locations SET parent_id=$2 WHERE id=$1',[id,parent]);
 const count=(await db.query("SELECT count(*) AS count FROM users WHERE role='admin' AND active=true")).rows[0].count;if(Number(count)!==1)throw new AuthError('BACKUP_ADMIN_MISSING');
}
export async function copyProtected(source,target){const input=await safeRead(source);let output;try{output=await open(target,'wx',0o600);for await(const chunk of input.createReadStream({autoClose:false}))await output.writeFile(chunk);await output.sync();}finally{await input.close();if(output)await output.close();}}
export async function atomicJson(path,value){const temp=path+'.'+randomUUID()+'.tmp';const h=await open(temp,'wx',0o600);try{await h.writeFile(JSON.stringify(value));await h.sync();}finally{await h.close();}await rename(temp,path);}
