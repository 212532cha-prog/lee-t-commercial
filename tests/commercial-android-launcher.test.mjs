import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { launchPairing } from '../mobile/launcher.mjs';
import { parsePairingQr } from '../public/app/pairing.js';

const clock = Date.parse('2026-11-06T08:00:00Z');
const origin = 'https://warehouse.local:3443';
const invitation = {
  schema: 1, type: 'leet-local-pairing', origin, serverId: randomUUID(),
  invitationId: randomUUID(), token: 'A'.repeat(43), expiresAt: new Date(clock + 120000).toISOString(),
};
const qr = origin + '/#pairing=' + encodeURIComponent(JSON.stringify(invitation));

test('Android launcher opens only a verified invitation in the external browser', async () => {
  const opened = [];
  const result = await launchPairing({
    scan: async () => ({ ScanResult: qr }),
    request: async options => {
      assert.equal(options.url, origin + '/api/commercial/server-identity');
      assert.equal(options.disableRedirects, true);
      assert.equal(options.data, undefined);
      assert.equal(JSON.stringify(options).includes(invitation.token), false);
      return { status: 200, url: options.url, data: { schema: 1, serverId: invitation.serverId } };
    },
    open: async options => opened.push(options.url),
    now: () => clock,
  });
  assert.equal(result, true);
  assert.equal(opened.length, 1);
  assert.deepEqual(parsePairingQr(opened[0], { now: clock }), invitation);
});

test('Android launcher leaves browser closed on cancellation, bad QR, redirected and mismatched servers', async () => {
  const open = () => assert.fail('Unexpected external browser launch');
  const request = () => assert.fail('Unexpected network request');
  assert.equal(await launchPairing({ scan: async () => ({}), open, request }), false);
  await assert.rejects(launchPairing({ scan: async () => ({ ScanResult: 'http://warehouse.local' }), open, request }), /INVALID_PAIRING_LINK/);
  for (const bad of [
    { status: 302, url: origin + '/api/commercial/server-identity', data: { schema: 1, serverId: invitation.serverId } },
    { status: 200, url: 'https://other.local/api/commercial/server-identity', data: { schema: 1, serverId: invitation.serverId } },
    { status: 200, url: origin + '/api/commercial/server-identity', data: { schema: 1, serverId: randomUUID() } },
  ]) {
    await assert.rejects(launchPairing({
      scan: async () => ({ ScanResult: qr }), open, request: async () => bad, now: () => clock,
    }), /PAIRING_SERVER_UNAVAILABLE|PAIRING_SERVER_MISMATCH/);
  }
});

test('Android launcher reports the failed native step without exposing plugin error details', async () => {
  const fail = async () => { throw Error(qr); };
  const launcher = {
    scan: async () => ({ ScanResult: qr }),
    request: async ({ url }) => ({ status: 200, url, data: { schema: 1, serverId: invitation.serverId } }),
    open: async () => {},
    now: () => clock,
  };
  for (const [step, message] of [
    ['scan', 'PAIRING_SCAN_FAILED'],
    ['request', 'PAIRING_HTTPS_FAILED'],
    ['open', 'PAIRING_BROWSER_FAILED'],
  ]) {
    await assert.rejects(launchPairing({ ...launcher, [step]: fail }), { message });
  }
});
