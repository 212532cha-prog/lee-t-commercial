import { localActivationRequest, storeLocalLicense } from './server-license.mjs';

import {activationPath} from './activation-protocol.mjs';
export {activationPath} from './activation-protocol.mjs';

export function activationEndpoint(settings){
  const value=settings.LEE_T_ACTIVATION_ENDPOINT;
  if(value!==undefined){
    if(typeof value!=='string'||value!==value.trim())throw Error('LEE_T_ACTIVATION_ENDPOINT must be a trusted HTTPS URL.');
    let url;try{url=new URL(value);}catch{throw Error('LEE_T_ACTIVATION_ENDPOINT must be a trusted HTTPS URL.');}
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||value.includes('?')||value.includes('#')||value.length>2048)throw Error('LEE_T_ACTIVATION_ENDPOINT must be a trusted HTTPS URL.');
    if(settings.LEE_T_ACTIVATION_ORIGIN&&url.origin!==settings.LEE_T_ACTIVATION_ORIGIN)throw Error('Activation endpoint and origin must match.');
    return url;
  }
  const origin = new URL(settings.LEE_T_ACTIVATION_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== settings.LEE_T_ACTIVATION_ORIGIN) throw Error('LEE_T_ACTIVATION_ORIGIN must be an HTTPS origin.');
  return new URL(activationPath,origin);
}

export async function activateOnline(settings, code, { readDevice, send = fetch } = {}) {
  if (!/^LT-[A-Za-z0-9_-]{32}$/.test(code)) throw Error('Invalid activation code.');
  const endpoint=activationEndpoint(settings);
  const request = await localActivationRequest(settings, { initialize: true, readDevice });
  const response = await send(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, request }),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw Error(`Lee T online activation failed (HTTP ${response.status}).`);
  const { license } = await response.json();
  return storeLocalLicense(settings, license, { readDevice });
}
