import {createServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {readFileSync} from 'node:fs';
import QRCode from 'qrcode';
import { identityPath } from '../commercial/discovery.mjs';
import { createRuoyiStatic } from '../dashboard/ruoyi-static.mjs';
import {AuthError} from './service.mjs';
const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/app.css',['app.css','text/css; charset=utf-8']],['/pairing.js',['pairing.js','text/javascript; charset=utf-8']],['/native-transport.js',['native-transport.js','text/javascript; charset=utf-8']],['/catalog.js',['catalog.js','text/javascript; charset=utf-8']],['/qr-print.js',['qr-print.js','text/javascript; charset=utf-8']],['/stock.js',['stock.js','text/javascript; charset=utf-8']],['/backup.js',['backup.js','text/javascript; charset=utf-8']],['/count.js',['count.js','text/javascript; charset=utf-8']],['/admin.js',['admin.js','text/javascript; charset=utf-8']]]);
const uuid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const cookie=raw=>`__Host-warehouse_session=${raw}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=34560000`;
const clearCookie=()=> '__Host-warehouse_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0';
const deviceCookie=raw=>`__Host-leet_device=${raw}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=34560000`;
function cookieToken(req,name){const prefix=name+'=';const matches=(req.headers.cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(prefix));return matches.length===1?matches[0].slice(prefix.length):'';}
async function body(req,limit=16384){if(Number(req.headers['content-length'])>limit)throw new AuthError('BODY_TOO_LARGE',413);if(req.headers['content-type']?.split(';')[0]!=='application/json')throw new AuthError('JSON_REQUIRED',415);let length=0,chunks=[];for await(const chunk of req){length+=chunk.length;if(length>limit)throw new AuthError('BODY_TOO_LARGE',413);chunks.push(chunk);}try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('object required');return value;}catch{throw new AuthError('INVALID_JSON');}}
export function createAuthServer({auth,publicOrigin,tunnelPublicOrigin,clock=()=>Date.now(),catalogRoutes,stockRoutes,backupRoutes,countRoutes,applicationRoutes,tls,localAdmin=false,ruoyiAdminDirectory}){
 if(localAdmin&&!tls)throw Error('Local administrator origin requires HTTPS');
 const localPort=Number(new URL(publicOrigin).port||443);
 const localAuthority='localhost'+(localPort===443?'':':'+localPort);
 const origins=new Set(tunnelPublicOrigin?[publicOrigin,tunnelPublicOrigin]:[publicOrigin]);
 for(const origin of origins){
  if(new URL(origin).protocol!=='https:'||new URL(origin).origin!==origin)throw Error('Allowed origins must use HTTPS');
 }
 const ruoyiAdmin=ruoyiAdminDirectory?createRuoyiStatic(ruoyiAdminDirectory):null;
 const attempts=new Map();
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
 const responses=new Set();const server=(tls?handler=>createHttpsServer(tls,handler):createServer)(async(req,res)=>{
  responses.add(res);const forget=()=>responses.delete(res);res.once('finish',forget);res.once('close',forget);
  res.setHeader('Strict-Transport-Security','max-age=31536000');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  let parsed,url;const write=!['GET','HEAD'].includes(req.method),raw=cookieToken(req,'__Host-warehouse_session'),csrf=req.headers['x-csrf-token'];
  try{
   try{if(!req.url.startsWith('/'))throw Error();parsed=new URL(req.url,'https://warehouse.invalid');url=parsed.pathname;}catch{throw new AuthError('INVALID_URL');}
   const localWrite=localAdmin&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)&&
    req.headers.host===localAuthority&&req.headers.origin==='https://'+localAuthority;
   if(write&&!origins.has(req.headers.origin)&&!localWrite)throw new AuthError('ORIGIN_REJECTED',403);
   if(ruoyiAdmin&&await ruoyiAdmin(req,res,url))return;
   if(req.method==='GET'&&url==='/brand/lee-t-logo.jpg'){res.writeHead(200,{'Content-Type':'image/jpeg'});res.end(readFileSync(new URL('../../public/brand/lee-t-logo.jpg',import.meta.url)));return;}
   if(req.method==='GET'&&url==='/fonts/business-regular.woff2'){res.writeHead(200,{'Content-Type':'font/woff2','Cache-Control':'public, max-age=86400'});res.end(readFileSync(new URL('../../node_modules/@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-400-normal.woff2',import.meta.url)));return;}
   if(req.method==='GET'&&url==='/vendor/jsqr.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(readFileSync(new URL('../../node_modules/jsqr/dist/jsQR.js',import.meta.url)));return;}
   if(req.method==='GET'&&assets.has(url)){const [name,type]=assets.get(url);res.writeHead(200,{'Content-Type':type});res.end(readFileSync(new URL('../../public/app/'+name,import.meta.url)));return;}
   if(auth.pairing&&req.method==='GET'&&url===identityPath){json(res,200,{schema:1,serverId:auth.pairing.serverId});return;}
   if(req.method==='POST'&&url==='/api/auth/login'){
    const input=await body(req);const key=req.socket.remoteAddress||'unknown';const last=attempts.get(key);const now=clock();
    if(last&&last.until>now&&last.count>=30)throw new AuthError('TOO_MANY_ATTEMPTS',429);
    if(attempts.size>10000)for(const [k,v]of attempts)if(v.until<=now)attempts.delete(k);
    const counter=last&&last.until>now?last:{count:0,until:now+60000};counter.count++;attempts.set(key,counter);
    const result=await auth.login(input.username,input.password,{invitation:input.invitation,device:cookieToken(req,'__Host-leet_device')});
    res.setHeader('Set-Cookie',result.deviceToken?[cookie(result.token),deviceCookie(result.deviceToken)]:cookie(result.token));
    json(res,200,{user:result.user,csrf:result.csrf,...(auth.pairing?{employeePairing:true}:{})});return;
   }
   if(auth.pairing&&raw&&url.startsWith('/api/')){
    await auth.pairing.checkSessionCookie(auth.pool,raw,cookieToken(req,'__Host-leet_device'));
   }
   if(req.method==='GET'&&url==='/api/me'){const result=await auth.authorize(raw,{sessionOnly:true});json(res,200,{...result,...(auth.pairing?{employeePairing:true}:{}),...(result.user.role==='admin'&&auth.pairing?.certificateFingerprint?{administratorMobilePairing:true}:{})});return;}
   if(req.method==='GET'&&url==='/api/commercial/administrator-qr'&&auth.pairing?.certificateFingerprint){
    await auth.authorize(raw,{admin:true});
    const {origin,serverId,certificateFingerprint}=auth.pairing;
    const link=new URL('/',origin);
    link.hash='warehouse='+encodeURIComponent(JSON.stringify({schema:1,origin,serverId,certificateFingerprint}));
    const qr=await QRCode.toBuffer(link.href,{width:320,errorCorrectionLevel:'M'});
    res.writeHead(200,{'Content-Type':'image/png'});res.end(qr);return;
   }
   if(req.method==='GET'&&url==='/api/state'){const a=await auth.authorize(raw,{sessionOnly:true});const flags=(await auth.pool.query('SELECT maintenance,admin_backup_required,clock_timestamp() AS server_time FROM system_settings WHERE id=1')).rows[0];const task=a.user.role==='employee'?(await auth.pool.query("SELECT id,run_generation FROM count_tasks WHERE assigned_user_id=$1 AND status='active'",[a.user.id])).rows[0]:null;json(res,200,{serverTime:flags.server_time,maintenance:flags.maintenance,adminBackupRequired:a.user.role==='admin'&&flags.admin_backup_required,task:task?{id:task.id,generation:String(task.run_generation)}:null});return;}
   if(req.method==='POST'&&url==='/api/auth/logout'){await auth.authorize(raw,{write:true,csrf,sessionOnly:true});await auth.logout(raw);res.setHeader('Set-Cookie',clearCookie());json(res,200,{ok:true});return;}
   if(req.method==='POST'&&url==='/api/me/password'){const a=await auth.authorize(raw,{admin:true,write:true,csrf});const input=await body(req);await auth.changeAdminPassword(a.user.id,input.oldPassword,input.newPassword,{raw,csrf});res.setHeader('Set-Cookie',clearCookie());json(res,200,{ok:true,requiresLogin:true});return;}
   if(auth.pairing&&req.method==='GET'&&url==='/api/commercial/diagnostic-config'){
    await auth.authorize(raw,{admin:true});
    res.setHeader('Content-Disposition','attachment; filename="paired-server.json"');
    json(res,200,{serverId:auth.pairing.serverId,origin:auth.pairing.origin});return;
   }
   if(url==='/api/employees'&&req.method==='GET'){await auth.authorize(raw,{admin:true});json(res,200,{employees:await auth.employees()});return;}
   if(url==='/api/employees'&&req.method==='POST'){await auth.authorize(raw,{admin:true,write:true,csrf});json(res,201,{employee:await auth.createEmployee(await body(req),{raw,csrf})});return;}
   const pairingMatch=url.match(/^\/api\/employees\/([^/]+)\/pairing\/(invite|unbind|signout)$/);
   if(auth.pairing&&pairingMatch&&req.method==='POST'){
    const [,id,action]=pairingMatch;
    const result=await auth.pairing.manage(auth,{raw,csrf},id,action);
    if(action==='invite'){
     const link=new URL('/',auth.pairing.origin);
     link.hash='pairing='+encodeURIComponent(JSON.stringify(result));
     const qr=await QRCode.toBuffer(link.href,{width:320,errorCorrectionLevel:'M'});
     json(res,201,{invitation:result,qrPng:qr.toString('base64')});
    }else json(res,200,result);
    return;
   }
   const match=url?.match(/^\/api\/employees\/([^/]+)(?:\/(disable|password))?$/);
   if(match&&['PATCH','POST'].includes(req.method)){
    if(!uuid.test(match[1]))throw new AuthError('INVALID_ID');await auth.authorize(raw,{admin:true,write:true,csrf});const input=await body(req);
    if(!match[2]&&req.method==='PATCH'){json(res,200,{employee:await auth.editEmployee(match[1],input,{raw,csrf})});return;}
    if(match[2]==='disable'&&req.method==='POST'){await auth.disableEmployee(match[1],{raw,csrf});json(res,200,{ok:true});return;}
    if(match[2]==='password'&&req.method==='POST'){await auth.resetEmployeePassword(match[1],input.newPassword,{raw,csrf});json(res,200,{ok:true});return;}
   }
   if(applicationRoutes&&await applicationRoutes({req,res,path:url,search:parsed.searchParams,raw,csrf,json,body}))return;
   if(countRoutes&&await countRoutes({req,res,path:url,search:parsed.searchParams,raw,csrf,json,body}))return;
   if(backupRoutes&&await backupRoutes({req,res,path:url,search:parsed.searchParams,raw,csrf,json,body}))return;
   if(stockRoutes&&await stockRoutes({req,res,path:url,search:parsed.searchParams,raw,csrf,json,body}))return;
   if(catalogRoutes&&await catalogRoutes({req,res,path:url,search:parsed.searchParams,raw,csrf,json,body}))return;
   json(res,404,{error:'NOT_FOUND'});
  }catch(error){if(res.headersSent){res.destroy();return;}const wrongCurrentPassword=url==='/api/me/password'&&req.method==='POST'&&error instanceof AuthError&&error.code==='INVALID_CREDENTIALS';if(error.status===401&&!wrongCurrentPassword)res.setHeader('Set-Cookie',clearCookie());json(res,error instanceof AuthError?error.status:500,{error:error instanceof AuthError?error.code:'INTERNAL_ERROR'});}
 });
 server.closeStreams=()=>{for(const res of responses)if(String(res.getHeader('Content-Type')).startsWith('text/event-stream'))res.end('data: '+JSON.stringify({error:'COUNT_RESTART_REQUIRED'})+'\n\n');};
 return server;
}
