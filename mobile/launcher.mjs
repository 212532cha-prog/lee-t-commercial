import { preparePairingSignIn } from '../public/app/pairing.js';

export async function launchPairing({ scan, request, open, now }) {
  const result = await Promise.resolve().then(scan).catch(() => {
    throw Error('PAIRING_SCAN_FAILED');
  });
  if (!result?.ScanResult) return false;
  const signIn = await preparePairingSignIn(result.ScanResult, {
    now,
    send: async url => {
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
    },
  });
  await Promise.resolve().then(() => open({ url: signIn })).catch(() => {
    throw Error('PAIRING_BROWSER_FAILED');
  });
  return true;
}
