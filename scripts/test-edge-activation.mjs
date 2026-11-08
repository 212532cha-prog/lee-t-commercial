import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
if(!process.env.LEE_T_EDGE_TEST_BUNDLE)throw Error('Build the standalone deployment bundle before testing.');
import {initializeActivationLedger,createInitialActivationCode,createFollowupActivationCode} from '../src/commercial/activation-ledger.mjs';
import {generateIssuerKeyPair,createDeviceRequest,verifyLicense} from '../src/commercial/license.mjs';
if(!globalThis.Deno||globalThis.Deno.version.deno!=='2.9.6')throw Error('Pinned Deno 2.9.6 is required.');
if(process.env.WAREHOUSE_NATIVE_PG!=='1'||!process.env.PGDATABASE?.endsWith('_test')||!process.env.LEE_T_EDGE_TEST_CA)throw Error('Dedicated native PostgreSQL test database and trusted test CA are mandatory.');
const ca=await readFile(process.env.LEE_T_EDGE_TEST_CA,'utf8');
const admin=new pg.Pool({max:1,ssl:{ca,rejectUnauthorized:true}}),suffix=randomUUID().replaceAll('-',''),schema='lee_t_license',role='edge_anon_'+suffix;
let pool,created=false,roleCreated=false;const children=[];
async function startServer(environment){
 const child=new globalThis.Deno.Command(globalThis.Deno.execPath(),{args:['run','--allow-env','--allow-read','--allow-net',process.env.LEE_T_EDGE_TEST_BUNDLE],env:{...environment,DENO_SERVE_ADDRESS:'tcp:127.0.0.1:0'},stdout:'piped',stderr:'piped'}).spawn();children.push(child);
 const reader=child.stdout.getReader();let text='';
 const ready=(async()=>{for(;;){const {value,done}=await reader.read();if(done)throw Error('Edge process exited before readiness.');text+=new TextDecoder().decode(value);const match=/LEE T activation edge ready:(\d+)/.exec(text);if(match){reader.releaseLock();return 'http://127.0.0.1:'+match[1]+'/functions/v1/lee-t-activation/v1/activation/redeem';}}})();
 let timer;try{return await Promise.race([ready,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Edge process readiness timeout.')),15000))]);}finally{clearTimeout(timer);}
}
try{
 assert.equal((await admin.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0].ssl,true);
 const untrusted=new pg.Pool({max:1,ssl:{rejectUnauthorized:true},connectionTimeoutMillis:3000});
 try{await assert.rejects(untrusted.query('SELECT 1'),error=>/certificate|issuer|self.signed/i.test(error.message));}finally{await untrusted.end();}
 assert.equal((await admin.query('SELECT to_regnamespace($1) AS name',[schema])).rows[0].name,null,'Refuse to replace an existing issuer schema');
 await admin.query('CREATE SCHEMA '+schema);created=true;
 await admin.query('REVOKE ALL ON SCHEMA '+schema+' FROM PUBLIC');
 pool=new pg.Pool({max:2,ssl:{ca,rejectUnauthorized:true},options:'-c search_path='+schema});await initializeActivationLedger(pool);
 const tables=(await pool.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[schema])).rows;
 for(const {tablename} of tables){if(!/^lee_t_[a-z_]+$/.test(tablename))throw Error('Unexpected test table');await pool.query('ALTER TABLE '+tablename+' ENABLE ROW LEVEL SECURITY');await pool.query('REVOKE ALL ON '+tablename+' FROM PUBLIC');}
 const issuer={...generateIssuerKeyPair(),keyId:'deno-test'},version='0.8.5',device={machineId:'deno-machine',boardId:'deno-board',systemDiskId:'deno-disk'},request=createDeviceRequest({device});
 const code=await createInitialActivationCode(pool,{customerId:'deno-customer',version,paid:true,expiresAt:new Date(Date.now()+60000)});
 const connection=new URL('postgresql://localhost');connection.hostname=process.env.PGHOST;connection.port=process.env.PGPORT;connection.username=process.env.PGUSER;connection.password=process.env.PGPASSWORD;connection.pathname='/'+process.env.PGDATABASE;
 const endpoint=await startServer({LEE_T_ISSUER_DATABASE_URL:connection.toString(),LEE_T_ISSUER_DB_CA:ca,LEE_T_ISSUER_PRIVATE_KEY:issuer.privateKeyPem,LEE_T_ISSUER_KEY_ID:issuer.keyId});
 const redeem=input=>fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
 const results=await Promise.all(Array.from({length:24},async()=>{const response=await redeem({code,request});assert.equal(response.status,200);return response.json();}));
 for(const row of results)assert.deepEqual(row,results[0]);const clients=(await admin.query("SELECT s.ssl FROM pg_stat_activity a JOIN pg_stat_ssl s ON s.pid=a.pid WHERE a.application_name='lee-t-activation-edge'")).rows;assert.ok(clients.length>=1&&clients.length<=2);assert.ok(clients.every(row=>row.ssl));
 assert.equal(verifyLicense({license:results[0].license,publicKeyPem:issuer.publicKeyPem,request,runningVersion:version}).valid,true);
 assert.equal(Number((await pool.query("SELECT count(*) AS n FROM lee_t_activation_audit WHERE event='redeemed'")).rows[0].n),1);
 assert.equal((await redeem({code,request:createDeviceRequest({device})})).status,403);
 const upgrade=await createFollowupActivationCode(pool,{customerId:'deno-customer',priorLicenseId:results[0].license.payload.licenseId,kind:'upgrade',version:'0.8.6',expiresAt:new Date(Date.now()+60000),request,paid:true,paymentReference:'deno-upgrade',approvedBy:'deno-issuer'});
 const upgraded=await redeem({code:upgrade,request});assert.equal(upgraded.status,200);assert.equal((await upgraded.json()).license.payload.kind,'upgrade');assert.equal((await redeem({code,request})).status,403);
 const missing=await fetch(new URL('/api/issue',endpoint),{method:'POST'});assert.equal(missing.status,404);
 const disabled=await startServer({LEE_T_ISSUER_DATABASE_URL:'',LEE_T_ISSUER_PRIVATE_KEY:'',LEE_T_ISSUER_KEY_ID:'',SUPABASE_DB_URL:''});assert.equal((await fetch(disabled,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,503);
 await admin.query('CREATE ROLE '+role+' NOLOGIN NOSUPERUSER');roleCreated=true;
 await admin.query('SET ROLE '+role);
 try{await assert.rejects(admin.query('SELECT * FROM '+schema+'.lee_t_activation_codes'),error=>error.code==='42501');}finally{await admin.query('RESET ROLE');}
 // Even an accidentally granted SELECT remains denied by default RLS for a non-owner.
 await admin.query('GRANT USAGE ON SCHEMA '+schema+' TO '+role);await admin.query('GRANT SELECT ON '+schema+'.lee_t_activation_codes TO '+role);
 await admin.query('SET ROLE '+role);try{assert.equal((await admin.query('SELECT * FROM '+schema+'.lee_t_activation_codes')).rows.length,0);}finally{await admin.query('RESET ROLE');}
 console.log('Deno Edge activation: real HTTP, trusted PostgreSQL TLS, untrusted CA rejection, concurrent redemption, signed offline verification, paid upgrade, device refusal, private-schema/RLS isolation and fail-closed startup passed.');
}finally{
 for(const child of children){try{child.kill('SIGTERM');}catch{/* Already exited. */}await child.status;}if(pool)await pool.end();
 if(created)await admin.query('DROP SCHEMA '+schema+' CASCADE');if(roleCreated)await admin.query('DROP ROLE '+role);await admin.end();
}
