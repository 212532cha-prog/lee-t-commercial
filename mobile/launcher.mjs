import { preparePairingSignIn } from '../public/app/pairing.js';

export async function launchPairing({ scan, request, open, now }) {
  const result = await scan();
  if (!result?.ScanResult) return false;
  const signIn = await preparePairingSignIn(result.ScanResult, {
    now,
    send: async url => {
      const response = await request({
        url: url.href, disableRedirects: true, connectTimeout: 5000, readTimeout: 5000,
        responseType: 'json', headers: { Accept: 'application/json' },
      });
      return {
        ok: response.status === 200 && response.url === url.href,
        json: () => response.data,
      };
    },
  });
  await open({ url: signIn });
  return true;
}
