import pg from 'pg';
import {createActivationHandler,activationReply,validateActivationIssuer} from '../../src/commercial/activation-fetch.mjs';
import {activationPath} from '../../src/commercial/activation-protocol.mjs';
import {issuerPoolOptions} from './edge-config.mjs';
const acceptedPaths=new Set([activationPath,'/lee-t-activation'+activationPath,'/functions/v1/lee-t-activation'+activationPath]);
export function createEdgeActivation({environment,poolFactory=options=>new pg.Pool(options),onError=()=>{}}){
 let handler,activePool;
 const serve=async request=>{
  const url=new URL(request.url);
  if(!acceptedPaths.has(url.pathname)||url.search)return activationReply(404,{error:'NOT_FOUND'});
  if(request.method!=='POST')return activationReply(405,{error:'METHOD_NOT_ALLOWED'},{Allow:'POST'});
  if(request.headers.get('content-type')!=='application/json')return activationReply(415,{error:'JSON_REQUIRED'});
  // Configuration is server-only. Missing signing material never falls back to a demo key.
  if(!handler){
   let pool;
   try{
    const issuer={privateKeyPem:environment.LEE_T_ISSUER_PRIVATE_KEY,keyId:environment.LEE_T_ISSUER_KEY_ID};
    validateActivationIssuer(issuer);
    pool=poolFactory(issuerPoolOptions(environment));activePool=pool;handler=createActivationHandler({pool,issuer,onError});
   }catch{if(pool)try{await pool.end();}catch{/* Preserve fail-closed startup. */}return activationReply(503,{error:'ACTIVATION_UNAVAILABLE'});}
  }
  url.pathname=activationPath;
  return handler(new Request(url,{method:request.method,headers:request.headers,body:request.body,duplex:'half'}));
 };
 serve.close=async()=>{const pool=activePool;activePool=undefined;handler=undefined;if(pool)await pool.end();};
 return serve;
}
