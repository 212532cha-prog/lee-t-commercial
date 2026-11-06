import { localActivationRequest, storeLocalLicense } from './server-license.mjs';

export const activationPath = '/v1/activation/redeem';

export async function activateOnline(settings, code, { readDevice, send = fetch } = {}) {
  if (!/^LT-[A-Za-z0-9_-]{32}$/.test(code)) throw Error('Invalid activation code.');
  const origin = new URL(settings.LEE_T_ACTIVATION_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== settings.LEE_T_ACTIVATION_ORIGIN) {
    throw Error('LEE_T_ACTIVATION_ORIGIN must be an HTTPS origin.');
  }
  const request = await localActivationRequest(settings, { initialize: true, readDevice });
  const response = await send(new URL(activationPath, origin), {
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
