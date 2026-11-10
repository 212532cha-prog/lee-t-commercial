import {invalidateExports} from '../export/invalidate.mjs';
import {randomUUID,randomBytes} from 'node:crypto';
import {transaction} from '../db/database.mjs';
import {AuthError} from '../auth/service.mjs';
export const UNASSIGNED='00000000-0000-4000-8000-000000000001';
const kinds={categories:'categories',suppliers:'suppliers',locations:'warehouse_locations'};
const lockMaster=db=>db.query('SELECT pg_advisory_xact_lock(20261121)');
const idPattern=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
export function identifier(value){if(typeof value!=='string'||!idPattern.test(value))throw new AuthError('INVALID_ID');return value;}
function name(value,max=128){if(typeof value!=='string'||!value.trim()||value.trim().length>max||/[\u0000-\u001f\u007f]/.test(value))throw new AuthError('INVALID_NAME');return value.trim();}
function amount(value){const v=String(value??'');if(!/^\d{1,12}(?:\.\d{1,2})?$/.test(v))throw new AuthError('INVALID_COST');return v;}
function integer(value){const n=Number(value);if(!['number','string'].includes(typeof value)||(typeof value==='string'&&!/^\d+$/.test(value))||!Number.isSafeInteger(n)||n<0)throw new AuthError('INVALID_MINIMUM');return n;}
function masterTable(kind){if(!Object.hasOwn(kinds,kind))throw new AuthError('MASTER_NOT_FOUND',404);return kinds[kind];}
async function ensureReferences(db,input,existing){
 const categoryId=input.categoryId===null&&existing?.category_id===null?null:identifier(input.categoryId),locationId=identifier(input.locationId);
 const category=categoryId?(await db.query('SELECT id,name FROM categories WHERE id=$1',[categoryId])).rows[0]:{id:null,name:existing.category_name_snapshot};
 if(!category)throw new AuthError('CATEGORY_NOT_FOUND',409);
 if(!(await db.query('SELECT id FROM warehouse_locations WHERE id=$1',[locationId])).rows.length)throw new AuthError('LOCATION_NOT_FOUND',409);
 if(!Array.isArray(input.supplierIds)||input.supplierIds.length>100)throw new AuthError('INVALID_SUPPLIERS');
 const ids=[...new Set(input.supplierIds.map(identifier))];
 const suppliers=ids.length?(await db.query('SELECT id,name FROM suppliers WHERE id=ANY($1::uuid[])',[ids])).rows:[];
 if(suppliers.length!==ids.length)throw new AuthError('SUPPLIER_NOT_FOUND',409);
 const defaultId=input.defaultSupplierId?identifier(input.defaultSupplierId):null;
 if(defaultId&&!ids.includes(defaultId))throw new AuthError('DEFAULT_SUPPLIER_NOT_SELECTED');
 return {category,locationId,suppliers,defaultId};
}
async function writeSuppliers(db,productId,{suppliers,defaultId}){
 await db.query('DELETE FROM product_suppliers WHERE product_id=$1',[productId]);
 for(const s of suppliers)await db.query('INSERT INTO product_suppliers(id,product_id,supplier_id,supplier_name_snapshot,is_default) VALUES($1,$2,$3,$4,$5)',[randomUUID(),productId,s.id,s.name,s.id===defaultId]);
}
export class CatalogService{
 constructor(pool,auth){this.pool=pool;this.auth=auth;}
 async guard(db,context){if(this.auth){if(!context)throw new AuthError('UNAUTHENTICATED',401);await this.auth.authorizeIn(db,context.raw,{admin:true,write:true,csrf:context.csrf});}}
 async masters(){
  const [categories,suppliers,locations]=await Promise.all(['categories','suppliers','warehouse_locations'].map(t=>this.pool.query(`SELECT * FROM ${t} ORDER BY lower(name) COLLATE "C",id`)));
  return {categories:categories.rows,suppliers:suppliers.rows,locations:locations.rows.map(r=>({id:r.id,name:r.name,parentId:r.parent_id,builtin:r.builtin,revision:String(r.revision)}))};
 }
 async addMaster(kind,input,context){
  const table=masterTable(kind),full=name(input.name),id=randomUUID();
  return transaction(this.pool,async db=>{await this.guard(db,context);await lockMaster(db);if(kind==='locations'){const parent=input.parentId?identifier(input.parentId):null;if(parent&&!(await db.query('SELECT id FROM warehouse_locations WHERE id=$1',[parent])).rows.length)throw new AuthError('LOCATION_NOT_FOUND',404);await db.query('INSERT INTO warehouse_locations(id,name,parent_id) VALUES($1,$2,$3)',[id,full,parent]);}else await db.query(`INSERT INTO ${table}(id,name) VALUES($1,$2)`,[id,full]);return {id,name:full};});
 }
 async editMaster(kind,id,input,context){
  const table=masterTable(kind);identifier(id);const full=name(input.name);
  return transaction(this.pool,async db=>{
   await this.guard(db,context);await lockMaster(db);const row=(await db.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`,[id])).rows[0];if(!row)throw new AuthError('MASTER_NOT_FOUND',404);
   if((context||input.revision!==undefined)&&String(input.revision)!==String(row.revision))throw new AuthError('MASTER_VERSION_CONFLICT',409);
   if(kind==='locations'){
    if(row.builtin)throw new AuthError('BUILTIN_LOCATION',409);
    const parent=input.parentId?identifier(input.parentId):null;
    if(parent){const ancestors=(await db.query('WITH RECURSIVE chain AS (SELECT id,parent_id FROM warehouse_locations WHERE id=$1 UNION ALL SELECT l.id,l.parent_id FROM warehouse_locations l JOIN chain c ON c.parent_id=l.id) SELECT id FROM chain',[parent])).rows;
     if(!ancestors.length)throw new AuthError('LOCATION_NOT_FOUND',404);if(ancestors.some(a=>a.id===id))throw new AuthError('LOCATION_CYCLE',409);
    }
    await db.query('UPDATE warehouse_locations SET name=$2,parent_id=$3,revision=revision+1 WHERE id=$1',[id,full,parent]);
   }else await db.query(`UPDATE ${table} SET name=$2,revision=revision+1 WHERE id=$1`,[id,full]);
   return {id,name:full};
  });
 }
 async deleteMaster(kind,id,context){
  const table=masterTable(kind);identifier(id);
  return transaction(this.pool,async db=>{
   await this.guard(db,context);await lockMaster(db);const row=(await db.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`,[id])).rows[0];if(!row)throw new AuthError('MASTER_NOT_FOUND',404);
   if(kind==='categories'){await db.query('UPDATE products SET category_name_snapshot=$2 WHERE category_id=$1',[id,row.name]);}
   if(kind==='suppliers'){await db.query('UPDATE product_suppliers SET supplier_name_snapshot=$2 WHERE supplier_id=$1',[id,row.name]);}
   if(kind==='locations'){
    if(row.builtin)throw new AuthError('BUILTIN_LOCATION',409);
    const ids=(await db.query('WITH RECURSIVE descendants AS (SELECT id FROM warehouse_locations WHERE id=$1 UNION ALL SELECT l.id FROM warehouse_locations l JOIN descendants d ON l.parent_id=d.id) SELECT id FROM descendants',[id])).rows.map(r=>r.id);
    await db.query('UPDATE products SET location_id=$2 WHERE location_id=ANY($1::uuid[])',[ids,UNASSIGNED]);
    await db.query('UPDATE warehouse_locations SET parent_id=$2 WHERE parent_id=$1',[id,UNASSIGNED]);
   }
   await db.query(`DELETE FROM ${table} WHERE id=$1`,[id]);return {deleted:true};
  });
 }
 async insertProduct(db,input,{full,cost,minimum}){
  const id=randomUUID(),qr='whp1_'+randomBytes(24).toString('base64url'),refs=await ensureReferences(db,input);
  let code,order;
  do{const n=(await db.query("SELECT nextval('product_code_sequence') AS number")).rows[0].number;order=String(n);code='P'+String(n).padStart(6,'0');}while((await db.query('SELECT id FROM products WHERE product_code=$1',[code])).rows.length);
  const duplicates=(await db.query('SELECT id FROM products WHERE name=$1',[full])).rows.length;
  await db.query('INSERT INTO products(id,product_code,name,category_id,category_name_snapshot,location_id,individual_cost,minimum_stock,qr_token,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,code,full,refs.category.id,refs.category.name,refs.locationId,cost,minimum,qr,order]);
  await db.query('INSERT INTO inventory_balances(product_id) VALUES($1)',[id]);await writeSuppliers(db,id,refs);
  return {id,productCode:code,duplicateName:duplicates>0};
 }
 async create(input,context){
  const fields={full:name(input.name),cost:amount(input.individualCost),minimum:integer(input.minimumStock)};
  return transaction(this.pool,async db=>{await this.guard(db,context);await lockMaster(db);return this.insertProduct(db,input,fields);});
 }
 async importProducts(categoryId,rows,{commit,context}){
  identifier(categoryId);
  if(!rows.length)throw new AuthError('IMPORT_NO_ROWS');
  return transaction(this.pool,async db=>{
   await this.guard(db,context);
   await lockMaster(db);
   const input={categoryId,locationId:UNASSIGNED,supplierIds:[]};
   await ensureReferences(db,input);
   const existing=new Set((await db.query('SELECT name FROM products WHERE category_id=$1',[categoryId])).rows.map(row=>row.name.toLowerCase()));
   const candidates=new Set(),errors=[],valid=[];
   for(const row of rows){
    try{
     const full=name(row.name),cost=amount(row.individualCost),minimum=integer(row.minimumStock),key=full.toLowerCase();
     if(existing.has(key)||candidates.has(key))throw new AuthError('IMPORT_DUPLICATE_NAME');
     candidates.add(key);
     valid.push({row:row.row,full,cost,minimum});
    }catch(error){if(!(error instanceof AuthError))throw error;errors.push({row:row.row,error:error.code});}
   }
   const products=[];
   if(commit&&!errors.length)for(const fields of valid)products.push(await this.insertProduct(db,input,fields));
   return {rows:valid,errors,products};
  });
 }
 async update(id,input,context){
  identifier(id);const full=name(input.name),cost=amount(input.individualCost),minimum=integer(input.minimumStock);
  try{return await transaction(this.pool,async db=>{
   await this.guard(db,context);await lockMaster(db);const row=(await db.query('SELECT product_code,category_id,category_name_snapshot,details_version FROM products WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new AuthError('PRODUCT_NOT_FOUND',404);
   if((context||input.detailsVersion!==undefined)&&String(input.detailsVersion)!==String(row.details_version))throw new AuthError('METADATA_VERSION_CONFLICT',409);
   const refs=await ensureReferences(db,input,row),code=input.productCode?name(input.productCode,64):row.product_code;
   await db.query('UPDATE products SET name=$2,product_code=$3,category_id=$4,category_name_snapshot=$5,location_id=$6,individual_cost=$7,minimum_stock=$8,updated_at=clock_timestamp(),details_version=details_version+1 WHERE id=$1',[id,full,code,refs.category.id,refs.category.name,refs.locationId,cost,minimum]);
   await writeSuppliers(db,id,refs);return {id};
  });}catch(error){if(error.code==='23505')throw new AuthError('PRODUCT_CODE_EXISTS',409);throw error;}
 }
 async detail(id,{admin=false}={}){
  identifier(id);const row=(await this.pool.query('SELECT p.*,b.quantity,b.version,c.name AS category_name,l.name AS location_name FROM products p JOIN inventory_balances b ON b.product_id=p.id LEFT JOIN categories c ON c.id=p.category_id JOIN warehouse_locations l ON l.id=p.location_id WHERE p.id=$1',[id])).rows[0];
  if(!row)throw new AuthError('PRODUCT_NOT_FOUND',404);
  const suppliers=(await this.pool.query('SELECT ps.supplier_id,ps.supplier_name_snapshot,ps.is_default,s.name FROM product_suppliers ps LEFT JOIN suppliers s ON s.id=ps.supplier_id WHERE ps.product_id=$1 ORDER BY ps.is_default DESC,ps.id',[id])).rows;
  return {...this.project(row,admin),qrToken:row.qr_token,suppliers:suppliers.map(s=>({id:s.supplier_id,name:s.name||s.supplier_name_snapshot,deleted:s.supplier_id===null,isDefault:s.is_default}))};
 }
 project(row,admin){return {id:row.id,productCode:row.product_code,name:row.name,categoryId:row.category_id,categoryName:row.category_name||row.category_name_snapshot,categoryDeleted:row.category_id===null,locationId:row.location_id,locationName:row.location_name,minimumStock:Number(row.minimum_stock),quantity:Number(row.quantity),inventoryVersion:String(row.version),detailsVersion:String(row.details_version),hasPhoto:!!row.photo_key,...(admin?{individualCost:row.individual_cost}:{} )};}
 async offlineInventory(){
  const {rows}=await this.pool.query(`SELECT p.product_code AS "productCode",p.name,b.quantity::text AS quantity
    FROM products p JOIN inventory_balances b ON b.product_id=p.id
    ORDER BY lower(p.name) COLLATE "C",p.sort_order LIMIT 5001`);
  const snapshot={synchronizedAt:new Date().toISOString(),products:rows};
  if(rows.length>5000||Buffer.byteLength(JSON.stringify(snapshot))>1500000)throw new AuthError('OFFLINE_INVENTORY_TOO_LARGE',413);
  return snapshot;
 }
 async list({categoryId,locationId,cursor,limit=20,q}={},role={}){
  limit=Number(limit);if(!Number.isInteger(limit)||limit<1||limit>100)throw new AuthError('INVALID_LIMIT');
  const filters=[categoryId||null,locationId||null];filters.forEach(v=>{if(v)identifier(v);});
  if(q!==undefined&&(typeof q!=='string'||q.length>128))throw new AuthError('INVALID_SEARCH');
  const query=q?.trim();if(query)filters.push(query);
  const values=[],where=[];const bind=v=>{values.push(v);return '$'+values.length;};
  if(categoryId)where.push(`p.category_id=${bind(categoryId)}`);if(locationId)where.push(`p.location_id=${bind(locationId)}`);
  if(query){const pattern=bind('%'+query.replace(/[\\%_]/g,'\\$&')+'%');where.push(`(p.name ILIKE ${pattern} OR p.product_code ILIKE ${pattern})`);}
  if(cursor){let parsed;try{if(typeof cursor!=='string'||cursor.length>2048)throw Error();parsed=JSON.parse(Buffer.from(cursor,'base64url').toString());if(JSON.stringify(parsed.filters)!==JSON.stringify(filters)||typeof parsed.name!=='string'||parsed.name.length>256||!/^\d{1,19}$/.test(parsed.order)||BigInt(parsed.order)>9223372036854775807n||BigInt(parsed.order)<1n)throw Error();}catch{throw new AuthError('INVALID_CURSOR');}where.push(`(lower(p.name) COLLATE "C",p.sort_order)>(${bind(parsed.name)} COLLATE "C",${bind(parsed.order)}::bigint)`);}
  const rows=(await this.pool.query(`SELECT p.*,b.quantity,b.version,c.name AS category_name,l.name AS location_name,lower(p.name) AS name_key FROM products p JOIN inventory_balances b ON b.product_id=p.id LEFT JOIN categories c ON c.id=p.category_id JOIN warehouse_locations l ON l.id=p.location_id ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY lower(p.name) COLLATE "C",p.sort_order LIMIT ${bind(limit+1)}`,values)).rows;
  const more=rows.length>limit,items=rows.slice(0,limit),last=items.at(-1);
  return {products:items.map(r=>this.project(r,role.admin===true)),nextCursor:more?Buffer.from(JSON.stringify({filters,name:last.name_key,order:String(last.sort_order)})).toString('base64url'):null};
 }
 async resolveToken(token,role){if(typeof token!=='string'||!/^whp1_[A-Za-z0-9_-]{32}$/.test(token))throw new AuthError('INVALID_QR',404);const row=(await this.pool.query('SELECT id FROM products WHERE qr_token=$1',[token])).rows[0];if(!row)throw new AuthError('PRODUCT_NOT_FOUND_OR_DELETED',404);return this.detail(row.id,role);}
 async delete(id,context){
  identifier(id);
  return transaction(this.pool,async db=>{
   await this.guard(db,context);await lockMaster(db);await db.query('SELECT pg_advisory_xact_lock_shared(20261131)');const row=(await db.query('SELECT photo_key FROM products WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new AuthError('PRODUCT_NOT_FOUND',404);
   const active=await db.query("SELECT ti.task_id FROM count_task_items ti JOIN count_tasks t ON t.id=ti.task_id WHERE ti.product_id=$1 AND t.status IN ('pending','active')",[id]);
   if(active.rows.length)throw new AuthError('PRODUCT_IN_ACTIVE_TASK',409);
   const recent=await db.query("SELECT id FROM inventory_events WHERE product_id=$1 AND created_at>clock_timestamp()-INTERVAL '168 hours' LIMIT 1",[id]);if(recent.rows.length)throw new AuthError('HISTORY_PROTECTED',409);
   if(row.photo_key)await db.query('INSERT INTO file_cleanup(file_key) VALUES($1) ON CONFLICT DO NOTHING',[row.photo_key]);
   await invalidateExports(db,{productId:id});
   await db.query('DELETE FROM products WHERE id=$1',[id]);
   await db.query('DELETE FROM count_reports r WHERE NOT EXISTS(SELECT 1 FROM count_report_items i WHERE i.report_id=r.id)');
   await db.query('DELETE FROM stock_drafts d WHERE NOT EXISTS(SELECT 1 FROM stock_draft_items i WHERE i.user_id=d.user_id)');
   await db.query('DELETE FROM stock_requests r WHERE NOT EXISTS(SELECT 1 FROM stock_request_items i WHERE i.request_id=r.id)');
   await db.query("DELETE FROM count_tasks t WHERE status IN ('completed','cancelled') AND NOT EXISTS(SELECT 1 FROM count_task_items i WHERE i.task_id=t.id)");return {deleted:true};
  });
 }
}
