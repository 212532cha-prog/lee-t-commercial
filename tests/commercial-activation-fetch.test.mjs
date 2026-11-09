import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {testPool} from './helpers/database.mjs';
import {createActivationHandler} from '../src/commercial/activation-fetch.mjs';
import {activationPath} from '../src/commercial/activation-protocol.mjs';
import {generateIssuerKeyPair,createDeviceRequest,verifyLicense} from '../src/commercial/license.mjs';
import {initializeActivationLedger,createInitialActivationCode,createFollowupActivationCode} from '../src/commercial/activation-ledger.mjs';
import {activateOnline,activationEndpoint} from '../src/commercial/activation-client.mjs';
import {requireLocalLicense} from '../src/commercial/server-license.mjs';
import {createEdgeActivation} from '../integrations/license-center/edge.mjs';
import {issuerPoolOptions} from '../integrations/license-center/edge-config.mjs';
const origin='https://activation.example.invalid';
const post=(input,path=activationPath)=>new Request(origin+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
async function fixture(t){
 const {pool}=await testPool();t.after(()=>pool.end());await initializeActivationLedger(pool);
 const issuer={...generateIssuerKeyPair(),keyId:'edge-test'},version=JSON.parse(await readFile(new URL('../package.json',import.meta.url))).version;
 const device={machineId:'machine-a',boardId:'board-a',systemDiskId:'disk-a'},request=createDeviceRequest({device}),code=await createInitialActivationCode(pool,{customerId:'edge-customer',version,paid:true,expiresAt:new Date(Date.now()+60000)});
 return {pool,issuer,version,device,request,code,handler:createActivationHandler({pool,issuer})};
}
test('Fetch activation shares the real ledger: concurrent replay signs once, ignores forged entitlements and rejects another installation',async t=>{
 const f=await fixture(t),input={code:f.code,request:f.request,paid:true,customerId:'forged',version:'999.0.0'};
 const responses=await Promise.all(Array.from({length:24},()=>f.handler(post(input))));assert.ok(responses.every(r=>r.status===200));
 const values=await Promise.all(responses.map(r=>r.json()));for(const value of values)assert.deepEqual(value,values[0]);
 const license=values[0].license;assert.equal(license.payload.customerId,'edge-customer');assert.equal(license.payload.entitledVersion,f.version);
 assert.equal(verifyLicense({license,publicKeyPem:f.issuer.publicKeyPem,request:f.request,runningVersion:f.version}).valid,true);
 assert.equal(Number((await f.pool.query("SELECT count(*) AS n FROM lee_t_activation_audit WHERE event='redeemed'")).rows[0].n),1);
 const different=createDeviceRequest({device:f.device});assert.equal((await f.handler(post({...input,request:different}))).status,403);
 assert.equal((await f.handler(post({code:f.code,request:{...f.request,claims:{...f.request.claims,machineId:'wrong'}}}))).status,403);
 assert.equal((await f.handler(post({...input,code:'LT-'+randomUUID()}))).status,403);
});
test('Fetch follow-up approvals preserve paid version/device rules and invalidate the superseded activation',async t=>{
 const f=await fixture(t),initial=(await (await f.handler(post({code:f.code,request:f.request}))).json()).license;
 const upgrade=await createFollowupActivationCode(f.pool,{customerId:'edge-customer',priorLicenseId:initial.payload.licenseId,kind:'upgrade',version:'999.0.0',paid:true,paymentReference:'edge-upgrade',approvedBy:'issuer-test',expiresAt:new Date(Date.now()+60000),request:f.request});
 const result=await f.handler(post({code:upgrade,request:f.request}));assert.equal(result.status,200);const newer=(await result.json()).license;
 assert.equal(newer.payload.kind,'upgrade');assert.equal(newer.payload.priorLicenseId,initial.payload.licenseId);assert.equal(newer.payload.entitledVersion,'999.0.0');
 assert.equal((await f.handler(post({code:f.code,request:f.request}))).status,403);
 await f.pool.query("UPDATE lee_t_activation_codes SET expires_at=clock_timestamp()-interval '1 second'");assert.equal((await f.handler(post({code:upgrade,request:f.request}))).status,403);
});
test('Fetch protocol bounds actual streamed bytes, rejects invalid UTF-8/JSON and exposes no issuing or management endpoint',async()=>{
 let calls=0;const pool={connect:()=>{calls++;throw Error('must not reach database');}},issuer={...generateIssuerKeyPair(),keyId:'edge-test'},handler=createActivationHandler({pool,issuer});
 for(const [path,method,status] of [['/v1/activation/issue','POST',404],['/api/customers','GET',404],[activationPath+'?code=hidden','POST',404],[activationPath,'GET',405],[activationPath,'OPTIONS',405]]){
  const response=await handler(new Request(origin+path,{method}));assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('access-control-allow-origin'),null);
 }
 assert.equal((await handler(new Request(origin+activationPath,{method:'POST',body:'{}'}))).status,415);
 for(const body of ['{','null','[]','0','"value"'])assert.equal((await handler(new Request(origin+activationPath,{method:'POST',headers:{'content-type':'application/json'},body}))).status,400);
 assert.equal((await handler(new Request(origin+activationPath,{method:'POST',headers:{'content-type':'application/json'},body:new Uint8Array([123,34,120,34,58,34,255,34,125])}))).status,400);
 let cancelled=false;
 const stream=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(2049));},cancel(){cancelled=true;}});
 const response=await handler(new Request(origin+activationPath,{method:'POST',headers:{'content-type':'application/json','content-length':'2'},body:stream,duplex:'half'}));
 assert.equal(response.status,413);assert.equal(cancelled,true);assert.equal(calls,0);
});
test('database and diagnostic failures produce a generic unavailable response without leaking submitted data',async()=>{
 const issuer={...generateIssuerKeyPair(),keyId:'edge-test'};let callbacks=0;
 const handler=createActivationHandler({pool:{connect:async()=>{throw Error('private database details');}},issuer,onError:()=>{callbacks++;throw Error('private diagnostic details');}});
 const input={code:'LT-'+'a'.repeat(32),request:createDeviceRequest({device:{machineId:'a',boardId:'b',systemDiskId:'c'}})};
 const response=await handler(post(input));assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'ACTIVATION_UNAVAILABLE'});assert.equal(callbacks,1);
 assert.throws(()=>createActivationHandler({pool:{connect(){}},issuer:{privateKeyPem:issuer.publicKeyPem,keyId:'bad'}}));
});
test('Edge configuration enforces TLS, pins its private schema and creates one reusable pool; unconfigured deployment never signs',async t=>{
 const f=await fixture(t),url=new URL('postgresql://database.example.invalid/issuer');url.username='issuer';url.password=randomUUID();url.search='sslmode=disable&options=-c%20search_path%3Dpublic';
 const environment={LEE_T_ISSUER_DATABASE_URL:url.toString(),LEE_T_ISSUER_PRIVATE_KEY:f.issuer.privateKeyPem,LEE_T_ISSUER_KEY_ID:f.issuer.keyId};
 const options=issuerPoolOptions(environment);assert.equal(options.ssl.rejectUnauthorized,true);assert.equal(options.options,'-c search_path=lee_t_license');assert.equal(new URL(options.connectionString).searchParams.has('sslmode'),false);assert.equal(new URL(options.connectionString).searchParams.has('options'),false);
 let pools=0;const edge=createEdgeActivation({environment,poolFactory:()=>{pools++;return f.pool;}});
 const path='/functions/v1/lee-t-activation'+activationPath;
 const responses=await Promise.all(Array.from({length:16},()=>edge(post({code:f.code,request:f.request},path))));assert.ok(responses.every(r=>r.status===200));assert.equal(pools,1);
 assert.equal((await edge(post({code:f.code,request:f.request},'/untrusted-prefix'+activationPath))).status,404);
 const disabled=createEdgeActivation({environment:{},poolFactory:()=>{throw Error('must not create pool');}});const unavailable=await disabled(post({code:f.code,request:f.request},path));assert.equal(unavailable.status,503);assert.deepEqual(await unavailable.json(),{error:'ACTIVATION_UNAVAILABLE'});
 const ownerUrl=new URL('postgresql://database.example.invalid/issuer');
 ownerUrl.username='owner';ownerUrl.password='test-only';
 assert.throws(()=>issuerPoolOptions({SUPABASE_DB_URL:ownerUrl.toString()}));
});
test('trusted full activation endpoint preserves the installation across a lost response and stores a locally verifiable license',async t=>{
 const f=await fixture(t),root=await mkdtemp(join(tmpdir(),'leet-fetch-client-'));t.after(()=>rm(root,{recursive:true,force:true}));const publicKey=join(root,'public.pem');await writeFile(publicKey,f.issuer.publicKeyPem);
 const settings={LEE_T_ACTIVATION_ENDPOINT:origin+'/functions/v1/lee-t-activation'+activationPath,LEE_T_LICENSE_DIR:join(root,'license'),LEE_T_ISSUER_PUBLIC_KEY_PATH:publicKey,LEE_T_ISSUER_KEY_ID:f.issuer.keyId};
 const dbUrl=new URL('postgresql://database.example.invalid/issuer');dbUrl.username='issuer';dbUrl.password=randomUUID();
 const edge=createEdgeActivation({environment:{LEE_T_ISSUER_DATABASE_URL:dbUrl.toString(),LEE_T_ISSUER_PRIVATE_KEY:f.issuer.privateKeyPem,LEE_T_ISSUER_KEY_ID:f.issuer.keyId},poolFactory:()=>f.pool});
 let dropped=false;const send=async(url,options)=>{assert.equal(options.redirect,'error');const response=await edge(new Request(url,options));if(!dropped){dropped=true;assert.equal(response.status,200);throw Error('response lost');}return response;};
 const options={readDevice:async()=>f.device,send};await assert.rejects(activateOnline(settings,f.code,options),/response lost/);
 const installed=await activateOnline(settings,f.code,options);assert.deepEqual(await requireLocalLicense(settings,{readDevice:async()=>f.device}),installed);
 assert.equal(Number((await f.pool.query("SELECT count(*) AS n FROM lee_t_activation_audit WHERE event='redeemed'")).rows[0].n),1);
});
test('activation endpoint configuration rejects plaintext, credentials, query tokens, fragments and mismatched origins',()=>{
 for(const endpoint of [42,'http://example.invalid/redeem','https://name:secret@example.invalid/redeem','https://example.invalid/redeem?token=secret','https://example.invalid/redeem#secret','https://example.invalid/redeem?','https://example.invalid/redeem#',' https://example.invalid/redeem'])assert.throws(()=>activationEndpoint({LEE_T_ACTIVATION_ENDPOINT:endpoint}),/trusted HTTPS/);
 assert.throws(()=>activationEndpoint({LEE_T_ACTIVATION_ENDPOINT:'https://a.example.invalid/redeem',LEE_T_ACTIVATION_ORIGIN:'https://b.example.invalid'}),/must match/);
 assert.equal(activationEndpoint({LEE_T_ACTIVATION_ORIGIN:origin}).href,origin+activationPath);
});
