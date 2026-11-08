import {createHash} from 'node:crypto';
import {transaction} from '../db/database.mjs';
import {AuthError} from '../auth/service.mjs';
import {identifier} from '../catalog/service.mjs';
export function whole(value,{positive=false}={}){
 if(!['number','string'].includes(typeof value)||!String(value).match(/^-?\d+$/)||!Number.isSafeInteger(Number(value))||(positive&&Number(value)<=0))throw new AuthError('INVALID_QUANTITY');return Number(value);
}
const safe=value=>{if(!Number.isSafeInteger(value))throw new AuthError('QUANTITY_OVERFLOW',409);return value;};
const key=value=>{if(!['number','string'].includes(typeof value)||!/^\d+$/.test(String(value))||BigInt(value)>9223372036854775807n)throw new AuthError('INVALID_VERSION');return String(value);};
export function stockLines(input){
 if(!Array.isArray(input)||!input.length||input.length>1000)throw new AuthError('INVALID_ITEMS');
 const seen=new Set();return input.map(row=>{const productId=identifier(row?.productId),canonical=productId.toLowerCase();if(seen.has(canonical))throw new AuthError('DUPLICATE_PRODUCT');seen.add(canonical);return {productId,quantity:whole(row.quantity,{positive:true})};}).sort((a,b)=>a.productId.localeCompare(b.productId));
}
async function negative(db,id,before,after){
 if(before>=0&&after<0)await db.query('INSERT INTO negative_notifications(product_id) VALUES($1) ON CONFLICT(product_id) DO UPDATE SET started_at=clock_timestamp(),read_at=NULL',[id]);
 if(after>=0)await db.query('DELETE FROM negative_notifications WHERE product_id=$1',[id]);
}
export async function lockStock(db,ids){
 // Product lock coordinates with deletion; stable UUID order prevents multi-product deadlocks.
 for(const id of [...new Set(ids)].sort()){
  if(!(await db.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[id])).rows.length)throw new AuthError('PRODUCT_NOT_FOUND_OR_DELETED',409);
  await db.query('SELECT product_id FROM inventory_balances WHERE product_id=$1 FOR UPDATE',[id]);
  await db.query('INSERT INTO inventory_checkpoints(product_id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
 }
}
export async function sealHistory(db,id){
 const checkpoint=(await db.query('SELECT * FROM inventory_checkpoints WHERE product_id=$1',[id])).rows[0];
 // Only the immutable prefix is summarized. No copies of old event details are kept.
 const firstRecent=(await db.query("SELECT min(id) AS id FROM inventory_events WHERE product_id=$1 AND id>$2 AND created_at>clock_timestamp()-INTERVAL '168 hours'",[id,checkpoint.through_id])).rows[0].id;
 const last=(await db.query('SELECT id,after_quantity FROM inventory_events WHERE product_id=$1 AND id>$2 AND ($3::bigint IS NULL OR id<$3) ORDER BY id DESC LIMIT 1',[id,checkpoint.through_id,firstRecent])).rows[0];
 if(last)await db.query('UPDATE inventory_checkpoints SET through_id=$2,quantity=$3 WHERE product_id=$1',[id,last.id,last.after_quantity]);
 return last?{through_id:last.id,quantity:last.after_quantity}:checkpoint;
}
export class StockService{
 constructor(pool,auth){this.pool=pool;this.auth=auth;}
 async run(raw,csrf,options,fn){return transaction(this.pool,async db=>{const actor=await this.auth.authorizeIn(db,raw,{write:true,csrf,...options});return fn(db,actor.user);});}
 async result(db,id,userId){const request=(await db.query('SELECT user_id FROM stock_requests WHERE id=$1',[id])).rows[0];if(!request||request.user_id!==userId)throw new AuthError('REQUEST_NOT_FOUND',404);const items=(await db.query('SELECT i.product_id,i.quantity,i.after_quantity,i.version,p.name,p.product_code FROM stock_request_items i JOIN products p ON p.id=i.product_id WHERE request_id=$1 ORDER BY product_id',[id])).rows;return {requestId:id,committed:true,items:items.map(r=>({productId:r.product_id,name:r.name,productCode:r.product_code,quantity:Number(r.quantity),afterQuantity:Number(r.after_quantity),version:String(r.version)}))};}
 async status(raw,id){identifier(id);const a=await this.auth.authorize(raw);return this.result(this.pool,id,a.user.id);}
 async preflight(raw,csrf,input){
  if(!['inbound','outbound'].includes(input.kind))throw new AuthError('INVALID_KIND');
  const lines=stockLines(input.items);
  return this.run(raw,csrf,{},async db=>{
   const rows=(await db.query('SELECT p.id,p.name,p.product_code,b.quantity,b.version FROM products p JOIN inventory_balances b ON b.product_id=p.id WHERE p.id=ANY($1::uuid[])',[lines.map(line=>line.productId)])).rows;
   if(rows.length!==lines.length)throw new AuthError('PRODUCT_NOT_FOUND_OR_DELETED',409);
   const byId=new Map(rows.map(row=>[row.id,row]));
   const items=lines.map(line=>{const row=byId.get(line.productId.toLowerCase()),quantity=whole(row.quantity);return {productId:row.id,name:row.name,productCode:row.product_code,quantity,requested:line.quantity,afterQuantity:safe(quantity+(input.kind==='inbound'?line.quantity:-line.quantity)),version:String(row.version)};});
   return {items,expectedVersions:Object.fromEntries(items.map(row=>[row.productId,row.version])),restoreMarker:(await db.query('SELECT restore_marker FROM system_settings WHERE id=1')).rows[0].restore_marker};
  });
 }
 async commit(raw,csrf,input){
  const id=identifier(input.requestId),kind=input.kind;if(!['inbound','outbound','adjustment'].includes(kind))throw new AuthError('INVALID_KIND');
  const lines=kind==='adjustment'?[{productId:identifier(input.productId),quantity:whole(input.quantity),expectedVersion:key(input.expectedVersion)}]:stockLines(input.items);
  let expectedVersions;
  if(input.expectedVersions!==undefined){
   if(!['inbound','outbound'].includes(kind)||!input.expectedVersions||typeof input.expectedVersions!=='object'||Array.isArray(input.expectedVersions)||Object.keys(input.expectedVersions).length!==lines.length)throw new AuthError('INVALID_VERSION');
   expectedVersions=Object.fromEntries(lines.map(line=>{const lookup=Object.hasOwn(input.expectedVersions,line.productId)?line.productId:line.productId.toLowerCase();if(!Object.hasOwn(input.expectedVersions,lookup))throw new AuthError('INVALID_VERSION');return [line.productId,key(input.expectedVersions[lookup])];}));
  }
  const hasMarker=Object.hasOwn(input,'restoreMarker');
  if(hasMarker&&input.restoreMarker!==null)identifier(input.restoreMarker);
  const fingerprint=createHash('sha256').update(JSON.stringify({kind,lines,...(expectedVersions&&{expectedVersions}),...(hasMarker&&{restoreMarker:input.restoreMarker})})).digest('hex');
  return this.run(raw,csrf,{admin:kind==='adjustment'},async(db,user)=>{
   if(hasMarker&&(await db.query('SELECT restore_marker FROM system_settings WHERE id=1')).rows[0].restore_marker!==input.restoreMarker)throw new AuthError('WAREHOUSE_RESTORED',409);
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[id]);
   const prior=(await db.query('SELECT * FROM stock_requests WHERE id=$1',[id])).rows[0];
   if(prior){if(prior.user_id!==user.id||prior.fingerprint!==fingerprint)throw new AuthError('IDEMPOTENCY_CONFLICT',409);return this.result(db,id,user.id);}
   await lockStock(db,lines.map(r=>r.productId));
   await db.query('INSERT INTO stock_requests(id,user_id,fingerprint) VALUES($1,$2,$3)',[id,user.id,fingerprint]);
   for(const line of lines){
    const b=(await db.query('SELECT quantity,version FROM inventory_balances WHERE product_id=$1',[line.productId])).rows[0];
    const before=whole(b.quantity),after=kind==='adjustment'?line.quantity:safe(before+(kind==='inbound'?line.quantity:-line.quantity));
    if(kind==='adjustment'&&line.expectedVersion!==String(b.version))throw new AuthError('STOCK_VERSION_CONFLICT',409);
    if(expectedVersions&&expectedVersions[line.productId]!==String(b.version))throw new AuthError('STOCK_VERSION_CONFLICT',409);
    await db.query('INSERT INTO inventory_events(product_id,kind,before_quantity,quantity_delta,after_quantity,created_by,request_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[line.productId,kind,before,safe(after-before),after,user.id,id]);
    const changed=(await db.query('UPDATE inventory_balances SET quantity=$2,version=version+1 WHERE product_id=$1 RETURNING version',[line.productId,after])).rows[0];
    await db.query('INSERT INTO stock_request_items(request_id,product_id,quantity,after_quantity,version) VALUES($1,$2,$3,$4,$5)',[id,line.productId,line.quantity,after,changed.version]);
    await negative(db,line.productId,before,after);
   }
   // A submitted saved draft must match its revision. Unrelated/newer drafts survive.
   if(input.draftRevision!==undefined){const draft=(await db.query('SELECT revision FROM stock_drafts WHERE user_id=$1 FOR UPDATE',[user.id])).rows[0];if(!draft||String(draft.revision)!==key(input.draftRevision))throw new AuthError('DRAFT_VERSION_CONFLICT',409);await db.query('DELETE FROM stock_drafts WHERE user_id=$1',[user.id]);}
   return this.result(db,id,user.id);
  });
 }
 async overwriteQuantity(raw,csrf,productId,input){
  identifier(productId);
  const quantity=whole(input?.quantity);
  if(quantity<0)throw new AuthError('INVALID_QUANTITY');
  const expectedVersion=key(input?.expectedVersion);
  return this.run(raw,csrf,{admin:true},async db=>{
   await lockStock(db,[productId]);
   const previous=(await db.query('SELECT quantity,version FROM inventory_balances WHERE product_id=$1',[productId])).rows[0];
   if(!previous)throw new AuthError('PRODUCT_NOT_FOUND_OR_DELETED',409);
   if(String(previous.version)!==expectedVersion)throw new AuthError('STOCK_VERSION_CONFLICT',409);
   // Preserve existing events, but make this unlogged overwrite the new replay anchor.
   // Old events cannot subsequently reconstruct and overwrite the manual quantity.
   const latest=(await db.query('SELECT max(id) AS id FROM inventory_events WHERE product_id=$1',[productId])).rows[0].id;
   await db.query('UPDATE inventory_checkpoints SET through_id=GREATEST(through_id,$2::bigint),quantity=$3 WHERE product_id=$1',[productId,latest??'0',quantity]);
   const changed=(await db.query('UPDATE inventory_balances SET quantity=$2,version=version+1 WHERE product_id=$1 RETURNING version',[productId,quantity])).rows[0];
   await negative(db,productId,whole(previous.quantity),quantity);
   return {productId,quantity,version:String(changed.version)};
  });
 }
 async draft(raw){return transaction(this.pool,async db=>{const a=await this.auth.authorizeIn(db,raw);const row=(await db.query('SELECT kind,revision,saved_at FROM stock_drafts WHERE user_id=$1',[a.user.id])).rows[0];if(!row)return {draft:null};const items=(await db.query('SELECT i.product_id,i.quantity,p.name,p.product_code FROM stock_draft_items i JOIN products p ON p.id=i.product_id WHERE user_id=$1 ORDER BY p.name',[a.user.id])).rows;return {draft:{kind:row.kind,revision:String(row.revision),savedAt:row.saved_at,items:items.map(i=>({productId:i.product_id,quantity:Number(i.quantity),name:i.name,productCode:i.product_code}))}};});}
 async saveDraft(raw,csrf,input){
  if(!['inbound','outbound'].includes(input.kind))throw new AuthError('INVALID_KIND');const lines=stockLines(input.items);
  return this.run(raw,csrf,{},async(db,user)=>{
   const old=(await db.query('SELECT revision FROM stock_drafts WHERE user_id=$1 FOR UPDATE',[user.id])).rows[0];
   if((old?String(old.revision):'0')!==key(input.expectedRevision))throw new AuthError('DRAFT_VERSION_CONFLICT',409);
   await lockStock(db,lines.map(r=>r.productId));
   const row=(await db.query("INSERT INTO stock_drafts(user_id,kind) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET kind=$2,revision=nextval('stock_draft_revision_sequence'),saved_at=clock_timestamp() RETURNING revision,saved_at",[user.id,input.kind])).rows[0];
   await db.query('DELETE FROM stock_draft_items WHERE user_id=$1',[user.id]);
   for(const line of lines)await db.query('INSERT INTO stock_draft_items(user_id,product_id,quantity) VALUES($1,$2,$3)',[user.id,line.productId,line.quantity]);
   return {revision:String(row.revision),savedAt:row.saved_at};
  });
 }
 async discardDraft(raw,csrf,input){return this.run(raw,csrf,{},async(db,user)=>{const r=await db.query('DELETE FROM stock_drafts WHERE user_id=$1 AND revision=$2 RETURNING user_id',[user.id,key(input.expectedRevision)]);if(!r.rows.length)throw new AuthError('DRAFT_VERSION_CONFLICT',409);return {discarded:true};});}
 async history(raw,productId,filters={}){
  return transaction(this.pool,async db=>{await this.auth.authorizeIn(db,raw);identifier(productId);const limit=Number(filters.limit??30);if(!Number.isInteger(limit)||limit<1||limit>100)throw new AuthError('INVALID_LIMIT');
  const oldest=filters.order==='oldest',values=[productId],where=['product_id=$1'];const bind=v=>{values.push(v);return '$'+values.length;};
  if(filters.kind){if(!['inbound','outbound','adjustment'].includes(filters.kind))throw new AuthError('INVALID_KIND');where.push('kind='+bind(filters.kind));}
  for(const [field,op]of [['from','>='],['to','<=']])if(filters[field]){const d=new Date(filters[field]);if(!Number.isFinite(d.getTime()))throw new AuthError('INVALID_DATE');where.push('created_at'+op+bind(d));}
  if(filters.cursor){if(!/^\d+$/.test(filters.cursor)||BigInt(filters.cursor)>9223372036854775807n)throw new AuthError('INVALID_CURSOR');where.push('id'+(oldest?'>':'<')+bind(filters.cursor));}
  const context=(await db.query('SELECT clock_timestamp() AS now,restore_marker FROM system_settings WHERE id=1')).rows[0],serverTime=context.now;
  const rows=(await db.query(`SELECT id,kind,before_quantity,quantity_delta,after_quantity,created_at,revision FROM inventory_events WHERE ${where.join(' AND ')} ORDER BY id ${oldest?'ASC':'DESC'} LIMIT ${bind(limit+1)}`,values)).rows;
  const events=rows.slice(0,limit).map(r=>({id:String(r.id),kind:r.kind,beforeQuantity:Number(r.before_quantity),quantityDelta:Number(r.quantity_delta),afterQuantity:Number(r.after_quantity),createdAt:r.created_at,revision:String(r.revision),protectedUntil:new Date(new Date(r.created_at).getTime()+168*3600000)}));return {serverTime,restoreMarker:context.restore_marker,events,nextCursor:rows.length>limit?events.at(-1).id:null}; });
 }
 async editHistory(raw,csrf,productId,eventId,input){
  identifier(productId);key(eventId);const value=whole(input.quantity),revision=key(input.expectedRevision);
  return this.run(raw,csrf,{admin:true},async(db)=>{
   await lockStock(db,[productId]);const event=(await db.query("SELECT *,created_at>clock_timestamp()-INTERVAL '168 hours' AS editable FROM inventory_events WHERE product_id=$1 AND id=$2",[productId,eventId])).rows[0];
   if(!event)throw new AuthError('EVENT_NOT_FOUND',404);if(!event.editable)throw new AuthError('HISTORY_IMMUTABLE',409);if(String(event.revision)!==revision)throw new AuthError('HISTORY_VERSION_CONFLICT',409);
   if(event.kind!=='adjustment'&&value<=0)throw new AuthError('INVALID_QUANTITY');
   const checkpoint=await sealHistory(db,productId);if(BigInt(eventId)<=BigInt(checkpoint.through_id))throw new AuthError('CHECKPOINT_CONFLICT',409);
   // Only a correction replays the editable suffix; routine stock commits never query it.
   const events=(await db.query('SELECT * FROM inventory_events WHERE product_id=$1 AND id>$2 ORDER BY id',[productId,checkpoint.through_id])).rows;let quantity=whole(checkpoint.quantity);
   for(const row of events){const before=quantity,isEdited=String(row.id)===String(eventId);quantity=row.kind==='adjustment'?(isEdited?value:whole(row.after_quantity)):safe(quantity+(isEdited?(row.kind==='outbound'?-value:value):whole(row.quantity_delta)));
    await db.query('UPDATE inventory_events SET before_quantity=$2,quantity_delta=$3,after_quantity=$4,revision=revision+1 WHERE id=$1',[row.id,before,safe(quantity-before),quantity]);
   }
   const old=(await db.query('SELECT quantity FROM inventory_balances WHERE product_id=$1',[productId])).rows[0];
   const changed=(await db.query('UPDATE inventory_balances SET quantity=$2,version=version+1 WHERE product_id=$1 RETURNING version',[productId,quantity])).rows[0];await negative(db,productId,whole(old.quantity),quantity);return {quantity,version:String(changed.version)};
  });
 }
}
