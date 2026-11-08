import { localActivationRequest, requireLocalLicense, storeLocalLicense } from './server-license.mjs';
import { activateOnline } from './activation-client.mjs';

export const desktopActivationInputLimit = 16384;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = error => ({ schema: 1, ok: false, error });

/** Private child-process protocol. No HTTP listener, paths or issuer settings come from input. */
export function createDesktopActivation(settings, { readDevice, send } = {}) {
  let busy = false;
  return async input => {
    if (!record(input) || input.schema !== 1 || typeof input.action !== 'string') return failure('INVALID_REQUEST');
    const actions = { status: [], request: [], activate: ['code'], import: ['license'] };
    const fields = Object.hasOwn(actions, input.action) ? actions[input.action] : undefined;
    if (!fields || Object.keys(input).some(key => !['schema', 'action', ...fields].includes(key)) ||
        fields.some(key => !Object.hasOwn(input, key))) return failure('INVALID_REQUEST');
    if (input.action === 'activate' && (typeof input.code !== 'string' || !/^LT-[A-Za-z0-9_-]{32}$/.test(input.code))) return failure('INVALID_CODE');
    if (input.action === 'import' && !record(input.license)) return failure('INVALID_LICENSE');
    if (busy) return failure('BUSY');
    busy = true;
    try {
      if (input.action === 'status') {
        try {
          const result = await requireLocalLicense(settings, { readDevice });
          return { schema: 1, ok: true, state: 'activated', version: result.entitledVersion };
        } catch { return { schema: 1, ok: true, state: 'activation-required' }; }
      }
      if (input.action === 'request') return {
        schema: 1, ok: true, request: await localActivationRequest(settings, { initialize: true, readDevice }),
      };
      if (input.action === 'activate') {
        await activateOnline(settings, input.code, { readDevice, send });
      } else {
        // An offline license must match the already exported installation identity.
        // Import must never create/rebind an identity or modify an invalid license.
        await storeLocalLicense(settings, input.license, { readDevice });
      }
      return { schema: 1, ok: true, state: 'activated' };
    } catch {
      // Never serialize exceptions: they may contain URLs, hardware, keys or submitted data.
      return failure(input.action === 'import' ? 'LICENSE_REJECTED' :
        input.action === 'activate' ? 'ACTIVATION_FAILED' : 'DEVICE_REQUEST_FAILED');
    } finally { busy = false; }
  };
}

export async function readDesktopActivationInput(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > desktopActivationInputLimit) throw Error('INVALID_REQUEST');
    chunks.push(bytes);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  return JSON.parse(text);
}
