import {createEdgeActivation} from './edge.mjs';
const runtime=globalThis.Deno;
if(!runtime?.serve)throw Error('Deno runtime is required.');
const names=['LEE_T_ISSUER_DATABASE_URL','LEE_T_ISSUER_DB_CA','LEE_T_ISSUER_PRIVATE_KEY','LEE_T_ISSUER_KEY_ID'];
const environment=Object.fromEntries(names.map(name=>[name,runtime.env.get(name)]));
runtime.serve({onListen({port}){console.log('LEE T activation edge ready:'+port);}},createEdgeActivation({environment,onError:()=>console.error('LEE T activation request failed.')}));
