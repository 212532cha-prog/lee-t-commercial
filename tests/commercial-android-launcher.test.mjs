import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { launchPairing, resumeWarehouse } from '../mobile/launcher.mjs';
import { parsePairingQr } from '../public/app/pairing.js';

const clock = Date.parse('2026-11-06T08:00:00Z');
const origin = 'https://warehouse.local:3443';
const invitation = {
  schema: 1, type: 'leet-local-pairing', origin, serverId: randomUUID(),
  invitationId: randomUUID(), token: 'A'.repeat(43), expiresAt: new Date(clock + 120000).toISOString(),
};
const qr = origin + '/#pairing=' + encodeURIComponent(JSON.stringify(invitation));

test('Android launcher opens only a verified invitation in the in-app workspace', async () => {
  const opened = [], remembered = [];
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
    remember: warehouse => remembered.push(warehouse),
    now: () => clock,
  });
  assert.equal(result, true);
  assert.equal(opened.length, 1);
  assert.deepEqual(parsePairingQr(opened[0], { now: clock }), invitation);
  assert.deepEqual(remembered, [{ origin, serverId: invitation.serverId }]);
});

test('Android launcher leaves the workspace closed on cancellation, bad QR, redirected and mismatched servers', async () => {
  const open = () => assert.fail('Unexpected workspace launch');
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
    ['open', 'PAIRING_WORKSPACE_FAILED'],
  ]) {
    await assert.rejects(launchPairing({ ...launcher, [step]: fail }), { message });
  }
});

test('Android workspace resume rechecks the saved identity and opens without an invitation', async () => {
  const warehouse = { origin, serverId: invitation.serverId };
  const opened = [];
  const request = async ({ url }) => {
    assert.equal(url, origin + '/api/commercial/server-identity');
    return { status: 200, url, data: { schema: 1, serverId: invitation.serverId } };
  };
  const open = async ({ url }) => opened.push(url);
  await resumeWarehouse({ warehouse, request, open });
  assert.deepEqual(opened, [origin + '/']);
  await assert.rejects(resumeWarehouse({
    warehouse: { ...warehouse, serverId: randomUUID() }, request, open,
  }), /PAIRING_SERVER_MISMATCH/);
  await assert.rejects(resumeWarehouse({
    warehouse: { ...warehouse, origin: 'http://warehouse.local' },
    request: () => assert.fail('Unexpected insecure request'), open,
  }), /INVALID_PAIRING_LINK/);
  assert.deepEqual(opened, [origin + '/']);
});

test('Android pairing uses the scanned pin for both the initial probe and resume and never falls back', async () => {
  const certificateFingerprint = 'ab'.repeat(32);
  const pinnedQr = origin + '/#pairing=' + encodeURIComponent(JSON.stringify({ ...invitation, certificateFingerprint }));
  const request = () => assert.fail('A pinned warehouse must not use the unpinned request.');
  const scan = async () => ({ ScanResult: pinnedQr });
  const opened = [];
  const open = async ({ url }) => opened.push(url);
  const now = () => clock;
  const remembered = [];
  const remember = warehouse => remembered.push(warehouse);
  await assert.rejects(launchPairing({ scan, request, open, now }), /PAIRING_PIN_REQUIRED/);
  const requestPinned = async options => {
    assert.deepEqual(options, { url: origin + '/api/commercial/server-identity', certificateFingerprint });
    return { status: 200, url: options.url, data: { schema: 1, serverId: invitation.serverId } };
  };
  await launchPairing({ scan, request, requestPinned, open, remember, now });
  assert.deepEqual(remembered, [{ origin, serverId: invitation.serverId, certificateFingerprint }]);
  await resumeWarehouse({ warehouse: remembered[0], request, requestPinned, open });
  assert.equal(opened.length, 2);
  await assert.rejects(resumeWarehouse({ warehouse: remembered[0], request, open }), /PAIRING_PIN_REQUIRED/);
  assert.equal(opened.length, 2);
});
