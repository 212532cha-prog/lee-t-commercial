import { parsePairingQr, preparePairingSignIn, verifyPairingServer } from '../public/app/pairing.js';

function nativeIdentityRequest(request) {
  return async url => {
    const response = await Promise.resolve().then(() => request({
      url: url.href, disableRedirects: true, connectTimeout: 5000, readTimeout: 5000,
      responseType: 'json', headers: { Accept: 'application/json' },
    })).catch(() => {
      throw Error('PAIRING_HTTPS_FAILED');
    });
    return {
      ok: response.status === 200 && response.url === url.href,
      json: () => response.data,
    };
  };
}

async function openWorkspace(open, url) {
  await Promise.resolve().then(() => open({ url })).catch(() => {
    throw Error('PAIRING_WORKSPACE_FAILED');
  });
}

export async function launchPairing({ scan, request, open, remember = () => {}, now = Date.now }) {
  const result = await Promise.resolve().then(scan).catch(() => {
    throw Error('PAIRING_SCAN_FAILED');
  });
  if (!result?.ScanResult) return false;
  const signIn = await preparePairingSignIn(result.ScanResult, { now, send: nativeIdentityRequest(request) });
  const { origin, serverId } = parsePairingQr(signIn, { now: now() });
  await openWorkspace(open, signIn);
  remember({ origin, serverId });
  return true;
}

export async function resumeWarehouse({ warehouse, request, open }) {
  await verifyPairingServer(warehouse, nativeIdentityRequest(request));
  await openWorkspace(open, new URL('/', warehouse.origin).href);
}
