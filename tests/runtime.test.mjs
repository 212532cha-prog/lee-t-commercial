import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadSettings,transport} from '../src/runtime/config.mjs';
import {createAuthServer} from '../src/auth/http.mjs';
let directory,cert,key,pfx,server,port;
before(async()=>{directory=await mkdtemp(join(tmpdir(),'warehouse-runtime-'));cert=join(directory,'cert.pem');key=join(directory,'key.pem');pfx=join(directory,'server.pfx');execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});const password=randomUUID();execFileSync('openssl',['pkcs12','-export','-out',pfx,'-inkey',key,'-in',cert,'-passout','stdin'],{input:password+'\n',stdio:['pipe','ignore','ignore']});const listener=await transport({TLS_PFX_PATH:pfx,TLS_PFX_PASSPHRASE:password,PUBLIC_ORIGIN:'https://localhost:3443',APP_PORT:'3443'});server=createAuthServer({auth:{},publicOrigin:'https://localhost:3443',tls:listener.tls});server.listen(0,'127.0.0.1');await once(server,'listening');port=server.address().port;});
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});});
const request=options=>new Promise((resolve,reject)=>{const req=https.get({host:'127.0.0.1',port,path:'/',...options},res=>{let body='';res.on('data',part=>body+=part);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});req.on('error',reject);});
test('protected JSON configuration accepts only explicit application fields and environment override',async()=>{const file=join(directory,'server.private.json');await writeFile(file,JSON.stringify({Environment:{DATABASE_URL:'<connection-string>',PUBLIC_ORIGIN:'https://localhost:3443',DATA_DIR:directory}}));const settings=await loadSettings({WAREHOUSE_CONFIG_PATH:file,DATA_DIR:'override'});assert.equal(settings.DATA_DIR,'override');assert.equal(settings.PUBLIC_ORIGIN,'https://localhost:3443');await writeFile(file,JSON.stringify({Environment:{DATABASE_URL:'<connection-string>',PUBLIC_ORIGIN:'https://localhost:3443',NODE_OPTIONS:'unexpected'}}));await assert.rejects(loadSettings({WAREHOUSE_CONFIG_PATH:file}),/INVALID_SERVER_CONFIGURATION/);});
test('plaintext can only bind loopback and direct HTTPS origin/port must match',async()=>{await assert.rejects(transport({APP_BIND:'0.0.0.0',PUBLIC_ORIGIN:'https://localhost'}),/LOOPBACK/);await assert.rejects(transport({TLS_CERT_PATH:cert,PUBLIC_ORIGIN:'https://localhost'}),/CERT_AND_KEY/);await assert.rejects(transport({TLS_CERT_PATH:cert,TLS_KEY_PATH:key,PUBLIC_ORIGIN:'https://localhost:4444',APP_PORT:'3443'}),/MISMATCH/);const safe=await transport({PUBLIC_ORIGIN:'https://localhost'});assert.equal(safe.bind,'127.0.0.1');assert.equal(safe.tls,undefined);});
test('actual application PFX HTTPS works only with trust and correct certificate hostname',async()=>{const res=await request({ca:await readFile(cert)});assert.equal(res.status,200);assert.ok(res.body.includes('id="app"'));assert.match(res.headers['strict-transport-security'],/max-age/);await assert.rejects(request({}),e=>['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN'].includes(e.code));await assert.rejects(request({ca:await readFile(cert),servername:'wrong.local'}),e=>e.code==='ERR_TLS_CERT_ALTNAME_INVALID');});

test('additional HTTPS tunnel origin permits only the exact hostname alongside the LAN origin',async()=>{
 const primary='https://warehouse.test:3443',tunnel='https://warehouse.example';
 const settings=await loadSettings({DATABASE_URL:'postgresql://localhost/test',PUBLIC_ORIGIN:primary,TUNNEL_PUBLIC_ORIGIN:tunnel});
 assert.equal(settings.TUNNEL_PUBLIC_ORIGIN,tunnel);
 await assert.rejects(loadSettings({...settings,TUNNEL_PUBLIC_ORIGIN:tunnel+'/path'}),/TUNNEL_PUBLIC_ORIGIN_REQUIRES_HTTPS/);
 const listener=createAuthServer({auth:{},publicOrigin:primary,tunnelPublicOrigin:tunnel});
 listener.listen(0,'127.0.0.1');await once(listener,'listening');
 try{
  for(const [origin,status] of [[primary,404],[tunnel,404],[tunnel+'.invalid',403],[undefined,403]]){
   const res=await fetch(`http://127.0.0.1:${listener.address().port}/unused`,{method:'POST',headers:origin?{Origin:origin}:{}});
   assert.equal(res.status,status);
  }
 }finally{listener.closeAllConnections();await new Promise(resolve=>listener.close(resolve));}
});
