import https from 'node:https';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const publicRoot=fileURLToPath(new URL('../../public/preflight/',import.meta.url));
const routes=new Map([
  ['/',{name:'index.html',type:'text/html; charset=utf-8'}],
  ['/probe.js',{name:'probe.js',type:'text/javascript; charset=utf-8'}],
  ['/style.css',{name:'style.css',type:'text/css; charset=utf-8'}],
]);
export function createProbeServer({key,cert,clock=()=>new Date()}={}) {
  if(!key||!cert)throw new Error('A trusted TLS certificate and private key are required; HTTP fallback is disabled.');
  return https.createServer({key,cert,minVersion:'TLSv1.2'},(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Permissions-Policy','camera=(self), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if(!['GET','HEAD'].includes(req.method)) {res.writeHead(405,{'Allow':'GET, HEAD'});res.end('Read-only diagnostic service');return;}
    // Only exact allowlisted paths are served. Query strings and path traversal cannot expose files.
    if(req.url==='/health'){
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});
      res.end(req.method==='HEAD'?undefined:JSON.stringify({service:'warehouse-stage0-probe',revision:'REQ-20261101',serverTime:clock().toISOString(),productionReady:false}));return;
    }
    const route=routes.get(req.url);
    if(!route){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('Not found');return;}
    try{const content=readFileSync(resolve(publicRoot,route.name));res.writeHead(200,{'Content-Type':route.type});res.end(req.method==='HEAD'?undefined:content);}
    catch{res.writeHead(503,{'Content-Type':'text/plain; charset=utf-8'});res.end('Diagnostic assets unavailable');}
  });
}
export function loadProbeConfig(env) {
  if(!env.PROBE_TLS_KEY||!env.PROBE_TLS_CERT)throw new Error('Set PROBE_TLS_KEY and PROBE_TLS_CERT to existing certificate files.');
  const port=Number(env.PROBE_PORT||8443);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PROBE_PORT must be 1..65535.');
  const host=env.PROBE_HOST||'127.0.0.1';
  if(!['127.0.0.1','0.0.0.0','::1'].includes(host))throw new Error('Use loopback or explicitly opt into LAN with PROBE_HOST=0.0.0.0.');
  return {key:readFileSync(env.PROBE_TLS_KEY),cert:readFileSync(env.PROBE_TLS_CERT),host,port};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  try {
    const config=loadProbeConfig(process.env),server=createProbeServer(config);
    server.on('error',error=>{console.error(`Probe server failed: ${error.code||'TLS_ERROR'}`);process.exitCode=1;});
    server.listen(config.port,config.host,()=>console.log(`Read-only stage-0 HTTPS probe on ${config.host}:${config.port}. No inventory/login backend is running.`));
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close());
  } catch(error){console.error(error.message);process.exitCode=1;}
}
