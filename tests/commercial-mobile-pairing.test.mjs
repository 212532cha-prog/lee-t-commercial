import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { parsePairingFragment, parsePairingQr, preparePairingSignIn } from '../public/app/pairing.js';

const now = Date.parse('2026-11-06T08:00:00Z');
const invitation = {
  schema: 1, type: 'leet-local-pairing', origin: 'https://warehouse.local:3443',
  serverId: randomUUID(), invitationId: randomUUID(), token: 'A'.repeat(43),
  expiresAt: new Date(now + 120000).toISOString(),
};
const qr = (value = invitation, origin = value.origin) => origin + '/#pairing=' + encodeURIComponent(JSON.stringify(value));

test('mobile QR parsing enforces HTTPS, matching origin, expiry and known fields', () => {
  assert.deepEqual(parsePairingQr(qr({ ...invitation, unexpected: 'discarded' }), { now }), invitation);
  assert.throws(() => parsePairingQr(qr(invitation, 'https://other.local'), { now }), /PAIRING_ORIGIN_MISMATCH/);
  for (const url of ['http://warehouse.local', 'https://name@warehouse.local', 'https://warehouse.local/other']) {
    assert.throws(() => parsePairingQr(qr(invitation, url), { now }), /INVALID_PAIRING_LINK/);
  }
  assert.throws(() => parsePairingFragment('#pairing=%ZZ', { now }), /INVALID_PAIRING_LINK/);
  assert.throws(() => parsePairingQr(qr(), { now: now + 120000 }), /PAIRING_LINK_EXPIRED/);
});

test('mobile sign-in verifies identity without sending the invitation and refuses expiry during the probe', async () => {
  const send = async (url, options) => {
    assert.equal(url.href, invitation.origin + '/api/commercial/server-identity');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body, undefined);
    return Response.json({ schema: 1, serverId: invitation.serverId });
  };
  const signIn = await preparePairingSignIn(qr(), { now: () => now, send });
  assert.deepEqual(parsePairingQr(signIn, { now }), invitation);
  await assert.rejects(preparePairingSignIn(qr(), {
    now: () => now, send: async () => Response.json({ schema: 1, serverId: randomUUID() }),
  }), /PAIRING_SERVER_MISMATCH/);
  let clock = now;
  await assert.rejects(preparePairingSignIn(qr(), {
    now: () => clock, send: async (...args) => { clock += 120000; return send(...args); },
  }), /PAIRING_LINK_EXPIRED/);
});
