import {invalidateExports} from '../export/invalidate.mjs';
import {createHash} from 'node:crypto';
import {AuthError} from '../auth/service.mjs';
import {identifier} from '../catalog/service.mjs';
import {lockStock,sealHistory} from './service.mjs';
const eventId=value=>{if(!['string','number'].includes(typeof value)||!/^\d+$/.test(String(value))||BigInt(value)>9223372036854775807n||BigInt(value)<1n)throw new AuthError('INVALID_EVENT_ID');return String(value);};
export class HistoryCleanup{
 constructor(pool,auth,backup,{fault}={}){this.pool=pool;this.auth=auth;this.backup=backup;this.fault=fault;}
 async clean(raw,csrf,productId,input){
  identifier(productId);const requestId=identifier(input.requestId);let ids,cutoff;
  if(input.ids!==undefined){if(!Array.isArray(input.ids)||!input.ids.length||input.ids.length>5000)throw new AuthError('INVALID_ITEMS');ids=[...new Set(input.ids.map(eventId))].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);}
  else{cutoff=new Date(input.cutoff);if(!Number.isFinite(cutoff.getTime()))throw new AuthError('INVALID_DATE');}
  const fingerprint=createHash('sha256').update(JSON.stringify({productId,ids,cutoff})).digest('hex');
  return this.backup.exclusive(async db=>{
   let actor;await db.query('BEGIN');try{actor=await this.auth.authorizeIn(db,raw,{admin:true,write:true,csrf});await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}
   const prior=(await db.query('SELECT * FROM inventory_cleanup_requests WHERE id=$1',[requestId])).rows[0];
   const project=r=>({deleted:r.deleted_count,backupId:r.backup_id,snapshotAt:r.snapshot_at,hasMore:r.has_more});
   if(prior){if(prior.user_id!==actor.user.id||prior.fingerprint!==fingerprint)throw new AuthError('IDEMPOTENCY_CONFLICT',409);return project(prior);}
   if(!(await db.query('SELECT id FROM products WHERE id=$1',[productId])).rows.length)throw new AuthError('PRODUCT_NOT_FOUND',404);
   const selected=ids?(await db.query("SELECT id,created_at<=clock_timestamp()-INTERVAL '168 hours' AS eligible FROM inventory_events WHERE product_id=$1 AND id=ANY($2::bigint[]) ORDER BY id",[productId,ids])).rows:(await db.query("SELECT id,true AS eligible FROM inventory_events WHERE product_id=$1 AND created_at<=$2 AND created_at<=clock_timestamp()-INTERVAL '168 hours' ORDER BY id LIMIT 5000",[productId,cutoff])).rows;
   if(ids&&(selected.length!==ids.length||selected.some(r=>!r.eligible)))throw new AuthError('HISTORY_PROTECTED_OR_MISSING',409);
   if(!selected.length)return {deleted:0,backupId:null};
   const backup=await this.backup.perform(db,'pre_cleanup');if(this.fault)await this.fault({phase:'after-backup',db});
   await db.query('BEGIN');try{
    await this.auth.authorizeIn(db,raw,{admin:true,write:true,csrf});await lockStock(db,[productId]);
    const selectedIds=selected.map(r=>String(r.id));
    const recheck=(await db.query("SELECT id FROM inventory_events WHERE product_id=$1 AND id=ANY($2::bigint[]) AND created_at<=clock_timestamp()-INTERVAL '168 hours' AND created_at<=$3",[productId,selectedIds,backup.snapshotAt])).rows;
    if(recheck.length!==selectedIds.length)throw new AuthError('CLEANUP_CHANGED',409);
    await sealHistory(db,productId);
    await invalidateExports(db,{eventIds:selectedIds});
    const removed=await db.query('DELETE FROM inventory_events WHERE product_id=$1 AND id=ANY($2::bigint[]) RETURNING id',[productId,selectedIds]);
    if(this.fault)await this.fault({phase:'after-delete'});
    const more=cutoff&&(await db.query("SELECT id FROM inventory_events WHERE product_id=$1 AND created_at<=$2 AND created_at<=clock_timestamp()-INTERVAL '168 hours' LIMIT 1",[productId,cutoff])).rows.length>0;
    const row=(await db.query('INSERT INTO inventory_cleanup_requests(id,product_id,user_id,fingerprint,backup_id,deleted_count,snapshot_at,has_more) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[requestId,productId,actor.user.id,fingerprint,backup.id,removed.rows.length,backup.snapshotAt,!!more])).rows[0];
    await db.query('COMMIT');return project(row);
   }catch(e){await db.query('ROLLBACK');throw e;}
  });
 }
}
