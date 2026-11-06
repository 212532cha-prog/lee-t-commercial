import https from 'node:https';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {X509Certificate} from 'node:crypto';
import {once} from 'node:events';
const server=https.createServer({pfx:await readFile(process.env.TEST_PFX),passphrase:process.env.TEST_PASSPHRASE,minVersion:'TLSv1.2'},(_req,res)=>res.end('trusted'));
server.listen(0,'127.0.0.1');await once(server,'listening');
const ca=new X509Certificate(await readFile(process.env.TEST_CA)).toString();
const get=servername=>new Promise((resolve,reject)=>{const req=https.get({host:'127.0.0.1',port:server.address().port,servername,ca},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve(body));});req.on('error',reject);});
try{assert.equal(await get('localhost'),'trusted');assert.equal(await get('192.168.10.25'),'trusted');await assert.rejects(get('wrong.local'),e=>e.code==='ERR_TLS_CERT_ALTNAME_INVALID');console.log('Windows-generated PFX chain, localhost and LAN SAN, wrong-host rejection passed.');}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
