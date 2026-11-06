import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readdir,rm,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import jsQR from 'jsqr';
import {testPool} from './helpers/database.mjs';
import {migrate} from '../src/db/database.mjs';
import {AuthService} from '../src/auth/service.mjs';
import {createAuthServer} from '../src/auth/http.mjs';
import {CatalogService,UNASSIGNED} from '../src/catalog/service.mjs';
import {PhotoStore,PHOTO_LIMIT} from '../src/catalog/files.mjs';
import {createCatalogRoutes} from '../src/catalog/routes.mjs';
import {workbookType,readProductWorkbook} from "../src/catalog/import-workbook.mjs";
import {workbookWithRows,productRow} from "./helpers/product-workbook.mjs";
let pool,auth,catalog,photos,server,base,directory,admin,staff,category,supplier;const origin='https://warehouse.test';
before(async()=>{const testDb=await testPool();pool=testDb.pool;console.log(`Catalog SQL tests: ${testDb.engine}`);await migrate(pool);await migrate(pool);directory=await mkdtemp(join(tmpdir(),'warehouse-photos-'));auth=new AuthService(pool);catalog=new CatalogService(pool);photos=new PhotoStore(pool,directory);server=createAuthServer({auth,publicOrigin:origin,catalogRoutes:createCatalogRoutes({auth,catalog,photos})});server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;});
after(async()=>{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(pool)await pool.end();if(directory)await rm(directory,{recursive:true,force:true});});
beforeEach(async()=>{
 for(const table of ['count_task_items','count_tasks','products','inventory_events','file_cleanup','categories','suppliers','sessions','users'])await pool.query(`DELETE FROM ${table}`);
 await pool.query('DELETE FROM warehouse_locations WHERE builtin=false');await pool.query('ALTER SEQUENCE product_code_sequence RESTART WITH 1');await pool.query('UPDATE system_settings SET maintenance=false,admin_backup_required=false');
 const secret=randomUUID();await auth.bootstrap(secret);admin=await auth.login('CTL LEE',secret);const credentials={username:'staff',realName:'Staff',password:randomUUID()};await auth.createEmployee(credentials);staff=await auth.login(credentials.username,credentials.password);
 category=await catalog.addMaster('categories',{name:'Fasteners'});supplier=await catalog.addMaster('suppliers',{name:'Johor Supply'});
 for(const f of await readdir(directory))await rm(join(directory,f),{recursive:true,force:true});
});
const input=(extra={})=>({name:'Bolt',categoryId:category.id,locationId:UNASSIGNED,individualCost:'0.80',minimumStock:10,supplierIds:[supplier.id],defaultSupplierId:supplier.id,...extra});
async function request(path,{method='GET',data,session=admin,raw,headers={}}={}){const res=await fetch(base+path,{method,headers:{...(session?{Cookie:`__Host-warehouse_session=${session.token}`,'X-CSRF-Token':session.csrf}:{}),...(method!=='GET'?{Origin:origin}:{}),...(data?{'Content-Type':'application/json'}:{}),...headers},body:raw??(data?JSON.stringify(data):undefined)});const type=res.headers.get('content-type')||'';const body=type.includes('application/json')?await res.json():Buffer.from(await res.arrayBuffer());return {status:res.status,headers:res.headers,body};}
async function stockEvent(id,{age=0,kind='inbound'}={}){await pool.query('INSERT INTO inventory_events(product_id,kind,quantity_delta,before_quantity,after_quantity,created_by,request_id,created_at) VALUES($1,$2,1,0,1,$3,$4,clock_timestamp()-($5::integer*INTERVAL \'1 hour\'))',[id,kind,admin.user.id,randomUUID(),age]);}
test('product is real, initially zero, generated code never reused; duplicate names are allowed and warned',async()=>{const a=await catalog.create(input()),b=await catalog.create(input());assert.equal(a.productCode,'P000001');assert.equal(b.productCode,'P000002');assert.equal(b.duplicateName,true);assert.equal((await catalog.detail(a.id)).quantity,0);await catalog.delete(a.id);const c=await catalog.create(input({name:'Another'}));assert.equal(c.productCode,'P000003');assert.equal((await pool.query('SELECT * FROM inventory_events')).rows.length,0);});
test('product input, supplier defaults and references fail atomically',async()=>{for(const extra of [{name:''},{individualCost:''},{individualCost:'-1'},{minimumStock:-1},{minimumStock:1.5},{categoryId:randomUUID()},{locationId:randomUUID()},{supplierIds:[]},{supplierIds:[randomUUID()]}])await assert.rejects(catalog.create(input(extra)));assert.equal((await pool.query('SELECT * FROM products')).rows.length,0);assert.equal((await pool.query('SELECT * FROM inventory_balances')).rows.length,0);});
test('concurrent product creates use unique codes and QR tokens',async()=>{const products=await Promise.all(Array.from({length:8},(_,i)=>catalog.create(input({name:'Part '+i}))));assert.equal(new Set(products.map(p=>p.productCode)).size,8);const tokens=await Promise.all(products.map(p=>catalog.detail(p.id)));assert.equal(new Set(tokens.map(p=>p.qrToken)).size,8);});
test('renaming and code edits leave QR and quantity stable; duplicate code is rejected',async()=>{const a=await catalog.create(input()),b=await catalog.create(input({name:'Other'})),before=await catalog.detail(a.id);await catalog.update(a.id,input({name:'Renamed',productCode:'CUSTOM-1'}));const after=await catalog.resolveToken(before.qrToken);assert.equal(after.name,'Renamed');assert.equal(after.productCode,'CUSTOM-1');assert.equal(after.quantity,0);await assert.rejects(catalog.update(b.id,input({productCode:'CUSTOM-1'})),e=>e.code==='PRODUCT_CODE_EXISTS');});
test('manual code reservation does not make later automatic numbering fail',async()=>{const a=await catalog.create(input());await catalog.update(a.id,input({productCode:'P000002'}));const b=await catalog.create(input());assert.equal(b.productCode,'P000003');});
test('deleting used category/supplier preserves latest names marked deleted without changing value or quantity',async()=>{const p=await catalog.create(input());await catalog.editMaster('categories',category.id,{name:'Updated category'});await catalog.editMaster('suppliers',supplier.id,{name:'Updated supplier'});await catalog.deleteMaster('categories',category.id);await catalog.deleteMaster('suppliers',supplier.id);const detail=await catalog.detail(p.id,{admin:true});assert.equal(detail.categoryName,'Updated category');assert.equal(detail.categoryDeleted,true);assert.equal(detail.suppliers[0].name,'Updated supplier');assert.equal(detail.suppliers[0].deleted,true);assert.equal(detail.individualCost,'0.80');assert.equal(detail.quantity,0);assert.equal((await catalog.masters()).categories.length,0);});
test('location cycles rejected; deleting parent moves products to unassigned and preserves child subtrees',async()=>{const a=await catalog.addMaster('locations',{name:'A'}),b=await catalog.addMaster('locations',{name:'B',parentId:a.id}),c=await catalog.addMaster('locations',{name:'C',parentId:b.id});const p=await catalog.create(input({locationId:c.id}));await assert.rejects(catalog.editMaster('locations',a.id,{name:'A',parentId:c.id}),e=>e.code==='LOCATION_CYCLE');await catalog.deleteMaster('locations',a.id);assert.equal((await catalog.detail(p.id)).locationId,UNASSIGNED);const locations=(await catalog.masters()).locations;assert.equal(locations.find(l=>l.id===b.id).parentId,UNASSIGNED);assert.equal(locations.find(l=>l.id===c.id).parentId,b.id);await assert.rejects(catalog.deleteMaster('locations',UNASSIGNED),e=>e.code==='BUILTIN_LOCATION');});
test('A-Z keyset pages and combined filters do not duplicate products; mismatched cursor rejected',async()=>{const location=await catalog.addMaster('locations',{name:'A shelf'}),other=await catalog.addMaster('categories',{name:'Other'});for(const name of ['zeta','Alpha','beta','Beta','gamma'])await catalog.create(input({name,locationId:location.id}));await catalog.create(input({name:'Excluded',categoryId:other.id}));let cursor,all=[];do{const page=await catalog.list({categoryId:category.id,locationId:location.id,limit:2,cursor});all.push(...page.products);cursor=page.nextCursor;}while(cursor);assert.deepEqual(all.map(p=>p.name),['Alpha','beta','Beta','gamma','zeta']);assert.equal(new Set(all.map(p=>p.id)).size,5);const first=await catalog.list({categoryId:category.id,limit:2});await assert.rejects(catalog.list({categoryId:other.id,cursor:first.nextCursor}),e=>e.code==='INVALID_CURSOR');});
test('employee and unauthenticated APIs cannot modify data or read cost',async()=>{const p=await catalog.create(input());for(const path of ['/api/products','/api/products/'+p.id,'/api/products/by-token/'+(await catalog.detail(p.id)).qrToken]){const r=await request(path,{session:staff});assert.equal(r.status,200);assert.ok(!JSON.stringify(r.body).includes('individualCost'));assert.ok(!JSON.stringify(r.body).includes('individual_cost'));}assert.equal((await request('/api/products',{session:null})).status,401);for(const [path,method] of [['/api/products','POST'],['/api/products/'+p.id,'PATCH'],['/api/products/'+p.id,'DELETE'],['/api/categories/'+category.id,'DELETE']])assert.equal((await request(path,{session:staff,method,data:input()})).status,403);});
test('QR SVG is decodable and remains stable after rename; print/download are admin-only',async()=>{const p=await catalog.create(input()),detail=await catalog.detail(p.id);const r=await request(`/api/products/${p.id}/qr`,{session:staff});assert.equal(r.status,200);const rgba=await sharp(r.body).ensureAlpha().raw().toBuffer({resolveWithObject:true});const code=jsQR(new Uint8ClampedArray(rgba.data),rgba.info.width,rgba.info.height);assert.equal(code.data,detail.qrToken);assert.ok(!code.data.includes('http'));await catalog.update(p.id,input({name:'Changed'}));assert.equal((await catalog.detail(p.id)).qrToken,detail.qrToken);assert.equal((await request(`/api/products/${p.id}/qr/download`,{session:staff})).status,403);assert.equal((await request(`/api/products/${p.id}/qr/print`)).status,200);assert.match((await request(`/api/products/${p.id}/qr/download`)).headers.get('content-disposition'),/attachment/);});
test('real JPG/PNG photos are sanitized; invalid bytes, mime, oversize and traversal IDs rejected',async()=>{const p=await catalog.create(input()),png=await sharp({create:{width:32,height:32,channels:3,background:'#245de8'}}).png().toBuffer();assert.equal((await request(`/api/products/${p.id}/photo`,{method:'PUT',raw:png,headers:{'Content-Type':'image/png'}})).status,200);const photo=await request(`/api/products/${p.id}/photo`,{session:staff});assert.equal(photo.status,200);assert.equal((await sharp(photo.body).metadata()).width,32);assert.equal((await request(`/api/products/${p.id}/photo`,{session:null})).status,401);for(const [buffer,mime]of [[Buffer.from('not png'),'image/png'],[png,'image/jpeg']])await assert.rejects(photos.replace(p.id,buffer,mime),e=>e.code==='INVALID_PHOTO');await assert.rejects(photos.replace(p.id,Buffer.alloc(PHOTO_LIMIT+1),'image/png'),e=>e.code==='PHOTO_TOO_LARGE');await assert.rejects(photos.get('../../secret'),e=>e.code==='INVALID_ID');});
test('photo replacement, removal and upload to missing product leave no silently retained files',async()=>{const p=await catalog.create(input()),image=await sharp({create:{width:8,height:8,channels:3,background:'#fff'}}).jpeg().toBuffer();await photos.replace(p.id,image,'image/jpeg');const first=(await readdir(directory))[0];await photos.replace(p.id,image,'image/jpeg');assert.equal((await readdir(directory)).length,1);assert.ok(!(await readdir(directory)).includes(first));await photos.remove(p.id);assert.equal((await readdir(directory)).length,0);await assert.rejects(photos.replace(randomUUID(),image,'image/jpeg'));assert.equal((await readdir(directory)).length,0);});
test('symlinked image is never served',async()=>{const p=await catalog.create(input()),key=randomUUID()+'.png',target=join(directory,'outside.txt');await writeFile(target,'private');await symlink(target,join(directory,key));await pool.query('UPDATE products SET photo_key=$2 WHERE id=$1',[p.id,key]);await assert.rejects(photos.get(p.id),e=>e.code==='PHOTO_NOT_FOUND');});
test('delete guards protect all recent event kinds and pending/active task references',async()=>{for(const kind of ['inbound','outbound','adjustment']){const p=await catalog.create(input());await stockEvent(p.id,{age:167,kind});await assert.rejects(catalog.delete(p.id),e=>e.code==='HISTORY_PROTECTED');}const p=await catalog.create(input());for(const status of ['pending','active']){const task=randomUUID();await pool.query('INSERT INTO count_tasks(id,title,status,assigned_user_id) VALUES($1,$2,$3,$4)',[task,'Task',status,status==='active'?staff.user.id:null]);await pool.query('INSERT INTO count_task_items(task_id,product_id) VALUES($1,$2)',[task,p.id]);await assert.rejects(catalog.delete(p.id),e=>e.code==='PRODUCT_IN_ACTIVE_TASK');await pool.query('DELETE FROM count_tasks WHERE id=$1',[task]);}});
test('exact 168-hour boundary allows permanent delete and cascades its state without touching other products',async()=>{const p=await catalog.create(input()),other=await catalog.create(input());await stockEvent(p.id,{age:168});const token=(await catalog.detail(p.id)).qrToken;const task=randomUUID();await pool.query("INSERT INTO count_tasks(id,title,status) VALUES($1,'old','cancelled')",[task]);await pool.query('INSERT INTO count_task_items(task_id,product_id) VALUES($1,$2)',[task,p.id]);assert.equal((await request('/api/products/'+p.id,{method:'DELETE'})).status,409);const result=await request('/api/products/'+p.id,{method:'DELETE',headers:{'X-Confirm-Permanent':'delete-product'}});assert.equal(result.status,200);for(const table of ['products','inventory_balances','inventory_events','product_suppliers','count_task_items']){const column=table==='products'?'id':'product_id';assert.equal((await pool.query(`SELECT * FROM ${table} WHERE ${column}=$1`,[p.id])).rows.length,0);}await assert.rejects(catalog.resolveToken(token),e=>e.code==='PRODUCT_NOT_FOUND_OR_DELETED');assert.equal((await catalog.detail(other.id)).quantity,0);assert.equal((await request('/api/product-trash')).status,404);});
test('photo cleanup failure is explicit, retained in retry queue, then drains',async()=>{const p=await catalog.create(input()),key=randomUUID()+'.png';await mkdir(join(directory,key));await pool.query('UPDATE products SET photo_key=$2 WHERE id=$1',[p.id,key]);await catalog.delete(p.id);assert.equal((await photos.drain()).cleanupPending,true);assert.equal((await pool.query('SELECT * FROM file_cleanup')).rows.length,1);await rm(join(directory,key),{recursive:true});assert.equal((await photos.drain()).cleanupPending,false);assert.equal((await pool.query('SELECT * FROM file_cleanup')).rows.length,0);});
test('migration checksum mismatch rejects startup rather than silently adopting changed SQL',async()=>{await pool.query("UPDATE schema_migrations SET checksum='changed' WHERE version=2");await assert.rejects(migrate(pool),/MIGRATION_CHANGED/);const {createHash}=await import('node:crypto'),{readFile}=await import('node:fs/promises');const hash=createHash('sha256').update(await readFile('migrations/002-catalog.sql')).digest('hex');await pool.query('UPDATE schema_migrations SET checksum=$1 WHERE version=2',[hash]);});

test('editing a product whose category was deleted can preserve its marked snapshot',async()=>{const p=await catalog.create(input());await catalog.deleteMaster('categories',category.id);await catalog.update(p.id,input({categoryId:null,name:'Edited',supplierIds:[],defaultSupplierId:null}));const row=await catalog.detail(p.id);assert.equal(row.name,'Edited');assert.equal(row.categoryDeleted,true);assert.equal(row.categoryName,'Fasteners');});
test('metadata input cannot change current stock; boolean and empty minimums are rejected',async()=>{const p=await catalog.create(input({quantity:100,inventoryVersion:50}));await catalog.update(p.id,input({quantity:999}));assert.equal((await catalog.detail(p.id)).quantity,0);for(const minimumStock of [false,[],{},'  '])await assert.rejects(catalog.create(input({minimumStock})),e=>e.code==='INVALID_MINIMUM');});

test('batch print is admin-only and every escaped label carries the original scannable token',async()=>{
 const first=await catalog.create(input({name:'Bolt <script>'}));
 const second=await catalog.create(input({name:'Nut & washer'}));
 const path='/api/products/qr/print-batch';
 const selected=path+'?id='+second.id+'&id='+first.id;
 assert.equal((await request(selected,{session:null})).status,401);
 assert.equal((await request(selected,{session:staff})).status,403);
 for(const invalid of [path,path+'?id=bad',path+'?id='+first.id+'&id='+first.id,path+'?'+new URLSearchParams(Array.from({length:51},()=>['id',randomUUID()]))]){
  assert.equal((await request(invalid)).status,400);
 }
 assert.equal((await request(selected+'&id='+randomUUID())).status,404);
 const result=await request(selected);
 assert.equal(result.status,200);
 assert.equal(result.headers.get('cache-control'),'no-store');
 const html=result.body.toString();
 assert.match(html,/Bolt &lt;script&gt;/);
 assert.match(html,/Nut &amp; washer/);
 assert.ok(html.indexOf(second.productCode)<html.indexOf(first.productCode));
 const labels=[...html.matchAll(/<svg\b[\s\S]*?<\/svg>/g)];
 assert.equal(labels.length,2);
 for(const [i,product] of [second,first].entries()){
  const qr=await sharp(Buffer.from(labels[i][0])).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const decoded=jsQR(new Uint8ClampedArray(qr.data),qr.info.width,qr.info.height);
  assert.equal(decoded?.data,(await catalog.detail(product.id)).qrToken);
 }
});

test('Excel template, preview and atomic commit enforce roles, CSRF, category and workbook binding',async()=>{
 const template=await request('/api/products/import-template');
 assert.equal(template.status,200);
 assert.match(template.headers.get('content-disposition'),/warehouse-products.xlsx/);
 assert.deepEqual(await readProductWorkbook(template.body),[]);
 assert.equal((await request('/api/products/import-template',{session:staff})).status,403);
 const good=await workbookWithRows(productRow(2,'螺丝', '1.25',4)+productRow(4,'Nut &amp; washer',0,1));
 const invalid=await workbookWithRows(productRow(2,'Bolt',1,0)+productRow(4,'Bad',2,-1));
 const send=(phase,raw,options={})=>request('/api/products/import-'+phase+'?categoryId='+category.id,{method:'POST',raw,...options,headers:{'Content-Type':workbookType,...options.headers}});
 assert.equal((await send('preview',good,{session:staff})).status,403);
 assert.equal((await send('preview',good,{headers:{'X-CSRF-Token':'invalid'}})).status,403);
 assert.equal((await send('commit',good)).status,409);
 assert.equal((await send('preview',Buffer.from('bad archive'))).status,400);
 assert.equal((await send('preview',Buffer.alloc(1024*1024+1))).status,413);
 const previewBad=await send('preview',invalid);
 assert.deepEqual(previewBad.body.errors,[{row:4,error:'INVALID_MINIMUM'}]);
 assert.equal(previewBad.body.previewToken,null);
 const preview=await send('preview',good);
 assert.equal(preview.status,200);
 assert.deepEqual(preview.body.rows.map(row=>[row.row,row.full,row.cost]),[[2,'螺丝','1.25'],[4,'Nut & washer','0']]);
 assert.equal((await catalog.list()).products.length,0);
 const options={headers:{'X-Import-Preview':preview.body.previewToken}};
 assert.equal((await send('commit',invalid,options)).status,409);
 const responses=await Promise.all([send('commit',good,options),send('commit',good,options)]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);
 const created=(await catalog.list()).products;
 assert.equal(created.length,2);
 for(const p of created){
  assert.equal(p.quantity,0);
  const detail=await catalog.detail(p.id);
  assert.equal((await catalog.resolveToken(detail.qrToken)).id,p.id);
 }
 const mixed=await workbookWithRows(productRow(2,'Fresh',1,0)+productRow(3,'Stale',1,0));
 const valid=await send('preview',mixed);
 await catalog.create(input({name:'STALE'}));
 const stale=await send('commit',mixed,{headers:{'X-Import-Preview':valid.body.previewToken}});
 assert.deepEqual(stale.body.errors,[{row:3,error:'IMPORT_DUPLICATE_NAME'}]);
 assert.equal((await catalog.list()).products.length,3);
});

test('Excel rejects formulas and sparse oversized cell addresses before allocating the sheet',async()=>{
 const formula=await workbookWithRows('<row r="2"><c r="B2"><f>1+1</f><v>2</v></c></row>');
 const sparse=await workbookWithRows(productRow(1048576,'Large',1,0));
 const outside=await workbookWithRows('<row r="2"><c r="XFD2"><v>1</v></c></row>');
 await assert.rejects(readProductWorkbook(formula),{code:'IMPORT_FORMULA_NOT_ALLOWED'});
 for(const file of [sparse,outside])await assert.rejects(readProductWorkbook(file),{code:'IMPORT_SHEET_LIMIT'});
});
