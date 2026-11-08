import assert from 'node:assert/strict';
import {sealRuoyiBundle} from './verify-ruoyi-bundle.mjs';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {testPool} from '../tests/helpers/database.mjs';
import {migrate} from '../src/db/database.mjs';
import {AuthService} from '../src/auth/service.mjs';
import {CatalogService,UNASSIGNED} from '../src/catalog/service.mjs';
import {StockService} from '../src/stock/service.mjs';
import {CountService} from '../src/count/service.mjs';
if(process.env.WAREHOUSE_NATIVE_PG!=='1')throw Error('Native PostgreSQL is required; no fallback or skipped runtime assertion.');
const {pool}=await testPool(),root=await mkdtemp(join(tmpdir(),'warehouse-native-runtime-')),children=[];
async function exit(child){if(child.exitCode!==null)return child.exitCode;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Runtime process timeout'));},25000);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});}
try{
 const management=join(root,'management');await mkdir(join(management,'static/js'),{recursive:true});await mkdir(join(management,'static/css'));
 for(const [name,content] of Object.entries({'index.html':'<title>LEE T Administration</title><script type="module" src="/admin/static/js/runtime.js"></script><link rel="stylesheet" href="/admin/static/css/runtime.css">','static/js/runtime.js':'/* LEE T runtime integration fixture */','static/css/runtime.css':'body{color:#334155}','RuoYi-LICENSE.txt':'Test fixture license','jsQR-LICENSE.txt':'Test fixture license'}))await writeFile(join(management,name),content);
 await sealRuoyiBundle(management);
 await migrate(pool);const schema=(await pool.query('SELECT current_schema() AS schema')).rows[0].schema;
 const auth=new AuthService(pool),password=randomUUID();
 const initialUrl=new URL('postgresql://localhost');initialUrl.hostname=process.env.PGHOST;initialUrl.port=process.env.PGPORT;initialUrl.username=process.env.PGUSER;initialUrl.password=process.env.PGPASSWORD;initialUrl.pathname='/'+process.env.PGDATABASE;initialUrl.searchParams.set('options','-c search_path='+schema);
 const dataDir=join(root,'data'),primary=join(root,'primary'),fallback=join(root,'fallback'),config=join(root,'server.private.json');await mkdir(dataDir);await mkdir(primary);await mkdir(fallback);await writeFile(config,JSON.stringify({Environment:{DATABASE_URL:initialUrl.toString(),PUBLIC_ORIGIN:'https://localhost',DATA_DIR:dataDir,LEE_T_RUOYI_ADMIN_DIR:management}}),{mode:0o600});
 async function initialize(initialPassword){const child=spawn(process.execPath,['scripts/initialize-server.mjs',...(process.platform==='win32'?['--require-local-listener']:[])],{env:{...process.env,WAREHOUSE_CONFIG_PATH:config},stdio:['pipe','pipe','pipe']});children.push(child);let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.resume();child.stdin.end(JSON.stringify({initialPassword,backupPath1:primary,backupPath2:fallback}));assert.equal(await exit(child),0);assert.ok(!output.includes(initialPassword));return output;}
 assert.match(await initialize(password),/Initial administrator created/);assert.match(await initialize(randomUUID()),/Existing administrator preserved/);const paths=(await pool.query('SELECT path1,path2 FROM backup_config WHERE id=1')).rows[0];assert.equal(paths.path1,primary);assert.equal(paths.path2,fallback);
 const admin=await auth.login('CTL LEE',password);await auth.createEmployee({username:'runtime-staff',realName:'Runtime Staff',password});const staff=await auth.login('runtime-staff',password);
 const catalog=new CatalogService(pool),category=await catalog.addMaster('categories',{name:'Runtime'}),product=await catalog.create({name:'Persistent',categoryId:category.id,locationId:UNASSIGNED,individualCost:'1',minimumStock:0,supplierIds:[]});await new StockService(pool,auth).commit(staff.token,staff.csrf,{requestId:randomUUID(),kind:'inbound',items:[{productId:product.id,quantity:7}]});const counts=new CountService(pool,auth),task=await counts.publish(admin.token,admin.csrf,{title:'Restart',scope:'all'});await counts.accept(staff.token,staff.csrf,task.id);const round=await counts.begin(staff.token,staff.csrf,task.id);await counts.connect(staff.token,staff.csrf,task.id,round);
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
 const url=new URL('postgresql://localhost');url.hostname=process.env.PGHOST;url.port=process.env.PGPORT;url.username=process.env.PGUSER;url.password=process.env.PGPASSWORD;url.pathname='/'+process.env.PGDATABASE;url.searchParams.set('options','-c search_path='+schema);
 const environment={...process.env,DATABASE_URL:url.toString(),PUBLIC_ORIGIN:'https://localhost',DATA_DIR:dataDir,APP_PORT:String(port),APP_BIND:'127.0.0.1',LEE_T_RUOYI_ADMIN_DIR:management};delete environment.WAREHOUSE_CONFIG_PATH;delete environment.BOOTSTRAP_ADMIN_PASSWORD;
 function start(){const child=spawn(process.execPath,['scripts/start-app.mjs'],{env:environment,stdio:['pipe','pipe','pipe']});children.push(child);let output='';const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Runtime readiness timeout')),25000);child.stdout.on('data',data=>{output+=data;if(output.includes('Warehouse ready.')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(Error('Runtime exited before readiness: '+code));});});ready.catch(()=>{});return {child,ready};}
 const first=start();await first.ready;assert.equal((await fetch('http://127.0.0.1:'+port+'/')).status,200);assert.match(await (await fetch('http://127.0.0.1:'+port+'/admin/')).text(),/LEE T Administration/);const duplicate=start();assert.equal(await exit(duplicate.child),1);assert.equal(first.child.exitCode,null);assert.equal((await counts.detail(staff.token,task.id)).task.assignedToMe,true);await assert.rejects(counts.submit(staff.token,staff.csrf,task.id,{...round,requestId:randomUUID(),items:[{productId:product.id,quantity:1}]}),e=>e.code==='COUNT_RESTART_REQUIRED');first.child.stdin.end('shutdown\n');assert.equal(await exit(first.child),0);await writeFile(join(management,'static/js/runtime.js'),'changed');const tampered=start();assert.equal(await exit(tampered.child),1);await writeFile(join(management,'static/js/runtime.js'),'/* LEE T runtime integration fixture */');const second=start();await second.ready;assert.equal((await catalog.detail(product.id)).quantity,7);assert.equal((await auth.login('CTL LEE',password)).user.id,admin.user.id);second.child.stdin.end('shutdown\n');assert.equal(await exit(second.child),0);console.log('Protected stdin initialization/preserved credentials/dual paths and native process migration/start/restart, singleton lease, stale count rejection, preserved inventory/admin, verified management entry, tampered-bundle startup rejection and graceful shutdown passed.');
}finally{for(const child of children)if(child.exitCode===null){child.kill('SIGTERM');await exit(child);}await pool.end();await rm(root,{recursive:true,force:true});}

await import("./test-native-offline-issuer.mjs");
