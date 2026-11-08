import {createPrivateKey} from 'node:crypto';
import {redeemActivationCode} from './activation-ledger.mjs';
import {activationPath,activationBodyLimit} from './activation-protocol.mjs';

export const activationHeaders={
 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
 'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
};
export const activationReply=(status,body,headers={})=>new Response(JSON.stringify(body),{status,headers:{...activationHeaders,...headers}});
export function validateActivationIssuer(issuer){
 if(typeof issuer?.keyId!=='string'||!issuer.keyId.trim()||issuer.keyId.length>160||createPrivateKey(issuer.privateKeyPem).asymmetricKeyType!=='ed25519')throw Error('INVALID_ACTIVATION_ISSUER');
 return issuer;
}
export async function redeemActivationInput(pool,input,issuer,onError=()=>{}){
 try{return {status:200,body:{license:await redeemActivationCode(pool,input,issuer)}};}
 catch(error){
  if(error.code==='INVALID_ACTIVATION_CODE')return {status:403,body:{error:error.code}};
  // Never log an activation code, device request, database URL or signing material.
  try{onError();}catch{/* Diagnostics must not replace the generic service response. */}
  return {status:503,body:{error:'ACTIVATION_UNAVAILABLE'}};
 }
}
async function readInput(request){
 const length=request.headers.get('content-length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>activationBodyLimit))throw Object.assign(Error(),{status:413,code:'PAYLOAD_TOO_LARGE'});
 if(!request.body)throw Error('Missing request');
 const reader=request.body.getReader();let bytes=0;const chunks=[];
 try{
  for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;
   if(bytes>activationBodyLimit){try{await reader.cancel();}catch{/* The response still reports the exceeded limit. */}throw Object.assign(Error(),{status:413,code:'PAYLOAD_TOO_LARGE'});}chunks.push(value);
  }
 }finally{reader.releaseLock();}
 const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength;}
 const input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid request');return input;
}
export function createActivationHandler({pool,issuer,onError=()=>{}}){
 if(!pool?.connect)throw Error('ACTIVATION_DATABASE_REQUIRED');validateActivationIssuer(issuer);
 return async request=>{
  const url=new URL(request.url);
  if(url.pathname!==activationPath||url.search)return activationReply(404,{error:'NOT_FOUND'});
  if(request.method!=='POST')return activationReply(405,{error:'METHOD_NOT_ALLOWED'},{Allow:'POST'});
  if(request.headers.get('content-type')!=='application/json')return activationReply(415,{error:'JSON_REQUIRED'});
  let input;try{input=await readInput(request);}catch(error){return activationReply(error.status||400,{error:error.code||'INVALID_REQUEST'});}
  const result=await redeemActivationInput(pool,input,issuer,onError);return activationReply(result.status,result.body);
 };
}
