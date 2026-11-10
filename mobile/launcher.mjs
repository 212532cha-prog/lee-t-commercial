import { parseAdministratorQr, parsePairingQr, preparePairingSignIn, verifyPairingServer } from '../public/app/pairing.js';

function nativeIdentityRequest(request, requestPinned, route, progress) {
  return async (url, { certificateFingerprint }) => {
    if (certificateFingerprint && !requestPinned) throw Error('PAIRING_PIN_REQUIRED');
    const response = await Promise.resolve().then(() => certificateFingerprint ? requestPinned({ url: url.href, certificateFingerprint, ...(route && { route }) }) : request({
      url: url.href, disableRedirects: true, connectTimeout: 5000, readTimeout: 5000,
      responseType: 'json', headers: { Accept: 'application/json' },
    })).catch(error => {
      throw Error(error?.code === 'PAIRING_CERTIFICATE_MISMATCH' ? error.code : 'PAIRING_HTTPS_FAILED');
    });
    progress('verifying');
    return {
      ok: response.status === 200 && response.url === url.href,
      json: () => response.data,
    };
  };
}

async function findWarehouseRoute(warehouse, { request, requestPinned, discover, progress }) {
  progress('connecting');
  if (warehouse.certificateFingerprint && requestPinned && warehouse.route) {
    try {
      await verifyPairingServer(warehouse, nativeIdentityRequest(request, requestPinned, warehouse.route, progress));
      return warehouse.route;
    } catch { /* A saved route is a hint and must pass the same verification. */ }
  }
  try {
    await verifyPairingServer(warehouse, nativeIdentityRequest(request, requestPinned, undefined, progress));
    return undefined;
  } catch (initialFailure) {
    if (!warehouse.certificateFingerprint || !requestPinned || !discover) throw initialFailure;
    progress('discovering');
    let addresses;
    try {
      const port = Number(new URL(warehouse.origin).port || 443);
      addresses = await discover({ serverId: warehouse.serverId, port });
    } catch {
      throw initialFailure;
    }
    if (!Array.isArray(addresses)) throw initialFailure;
    for (const route of [...new Set(addresses)].slice(0, 8)) {
      if (route === warehouse.route || typeof route !== 'string' || !/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(route)) continue;
      try {
        await verifyPairingServer(warehouse, nativeIdentityRequest(request, requestPinned, route, progress));
        return route;
      } catch { /* Discovery data is only a route hint. */ }
    }
    throw initialFailure;
  }
}

async function openWorkspace(open, url, certificateFingerprint, route) {
  await Promise.resolve().then(() => open({ url, ...(certificateFingerprint && { certificateFingerprint }), ...(route && { route }) })).catch(() => {
    throw Error('PAIRING_WORKSPACE_FAILED');
  });
}

export async function launchPairing({ scan, request, requestPinned, discover, open, remember = () => {}, progress = () => {}, now = Date.now, administrator = false }) {
  const result = await Promise.resolve().then(scan).catch(() => {
    throw Error('PAIRING_SCAN_FAILED');
  });
  if (!result?.ScanResult) return false;
  if (administrator) {
    const warehouse = parseAdministratorQr(result.ScanResult);
    const route = await findWarehouseRoute(warehouse, { request, requestPinned, discover, progress });
    progress('opening');
    await openWorkspace(open, new URL('/', warehouse.origin).href, warehouse.certificateFingerprint, route);
    remember({ ...warehouse, ...(route && { route }) });
    return true;
  }
  let route;
  const signIn = await preparePairingSignIn(result.ScanResult, {
    now, verify: async invitation => { route = await findWarehouseRoute(invitation, { request, requestPinned, discover, progress }); },
  });
  const { origin, serverId, certificateFingerprint } = parsePairingQr(signIn, { now: now() });
  progress('opening');
  await openWorkspace(open, signIn, certificateFingerprint, route);
  remember({ origin, serverId, ...(certificateFingerprint && { certificateFingerprint }), ...(route && { route }) });
  return true;
}

export async function resumeWarehouse({ warehouse, request, requestPinned, discover, open, remember = () => {}, progress = () => {} }) {
  const route = await findWarehouseRoute(warehouse, { request, requestPinned, discover, progress });
  progress('opening');
  await openWorkspace(open, new URL('/', warehouse.origin).href, warehouse.certificateFingerprint, route);
  const { route: previousRoute, ...identity } = warehouse;
  if (route !== previousRoute) remember({ ...identity, ...(route && { route }) });
}
