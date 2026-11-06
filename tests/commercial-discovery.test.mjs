import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createAuthServer } from '../src/auth/http.mjs';
import { advertiseWarehouse, discoveryConfig, discoveryRecord, findWarehouse, maintainWarehouseAdvertisement, requestWarehouseIdentity, verifyWarehouseAddress, verifyWarehouseCandidate } from '../src/commercial/discovery.mjs';

test('discovery ignores mismatched IDs, hosts and ports before attempting HTTPS', async () => {
  const paired = { serverId: randomUUID(), origin: 'https://warehouse.local:3443' };
  const service = { type: 'leet-warehouse', protocol: 'tcp', host: 'warehouse.local', port: 3443, addresses: ['127.0.0.1'], txt: { id: paired.serverId, v: '1' } };
  for (const candidate of [{ ...service, host: 'other.local' }, { ...service, port: 443 }, { ...service, txt: { id: randomUUID(), v: '1' } }]) {
    assert.equal(await verifyWarehouseCandidate(candidate, paired, { send: () => assert.fail('Must not connect to spoofed candidate') }), null);
  }
  assert.equal(await verifyWarehouseCandidate(service, paired, { send: async () => Response.json({ schema: 1, serverId: randomUUID() }) }), null);
  assert.throws(() => discoveryConfig({ LEE_T_MDNS: '1' }, paired, { bind: '127.0.0.1', tls: true }), /direct HTTPS LAN listener/);
  assert.throws(() => discoveryRecord({ ...paired, origin: 'https://public.example' }), /mDNS host/);
});

test('real multicast DNS resolves a server only after certificate and HTTPS identity verification', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'leet-mdns-'));
  const host = 'leet-discovery-' + randomUUID().slice(0, 8) + '.local';
  const keyPath = join(directory, 'key.pem'), certPath = join(directory, 'cert.pem');
  let server, advertisement;
  t.after(async () => {
    await advertisement?.close();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=' + host, '-addext', 'subjectAltName=DNS:' + host], { stdio: 'ignore' });
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  const serverId = randomUUID();
  server = createAuthServer({ auth: { pairing: { serverId } }, publicOrigin: 'https://' + host, tls: { key, cert } });
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  const paired = { serverId, origin: 'https://' + host + ':' + server.address().port };
  const socket = createSocket('udp4');
  socket.bind(0, '0.0.0.0');
  await once(socket, 'listening');
  const options = { port: socket.address().port, interface: '127.0.0.1', bind: '0.0.0.0' };
  await new Promise(resolve => socket.close(resolve));
  let currentAddress = '127.0.0.1';
  const tlsRequest = ca => (url, options) => {
    assert.equal(url.hostname, host);
    assert.equal(options.address, currentAddress);
    return requestWarehouseIdentity(url, { ...options, ca });
  };
  // Use a fixed loopback interface fixture while exchanging real multicast packets.
  t.mock.method(os, 'networkInterfaces', () => ({ test: [{ address: currentAddress, family: 'IPv4', internal: false, mac: '02:00:00:00:00:01' }] }));
  advertisement = advertiseWarehouse(discoveryRecord(paired), { options });
  const [verified, untrusted, unrelated] = await Promise.all([
    findWarehouse(paired, { options, timeoutMs: 6500, send: tlsRequest(cert) }),
    findWarehouse(paired, { options, timeoutMs: 2200, send: tlsRequest() }),
    findWarehouse({ ...paired, serverId: randomUUID() }, { options, timeoutMs: 2200, send: () => assert.fail('Unexpected HTTPS request') }),
  ]);
  assert.equal(verified, paired.origin);
  assert.equal(untrusted, null);
  assert.equal(unrelated, null);
  assert.equal(await verifyWarehouseAddress(paired, '127.0.0.1', { send: tlsRequest(cert) }), paired.origin);
  await assert.rejects(verifyWarehouseAddress(paired, '127.0.0.1', { send: tlsRequest() }));
  await assert.rejects(verifyWarehouseAddress(paired, 'https://other.local'), /valid server IP/);
  await advertisement.close();
  assert.equal(await findWarehouse(paired, { options, timeoutMs: 700, send: tlsRequest(cert) }), null);
  currentAddress = '127.0.0.2';
  advertisement = advertiseWarehouse(discoveryRecord(paired), { options });
  assert.deepEqual(await findWarehouse(paired, { options, send: tlsRequest(cert), includeAddress: true }), {
    origin: paired.origin, address: '127.0.0.2',
  });
  const fixture = join(directory, 'paired-server.json');
  await writeFile(fixture, JSON.stringify({ ...paired, token: 'unused-fixture-token' }));
  const runDiagnostic = promisify(execFile);
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: certPath };
  const args = ['scripts/find-warehouse.mjs', '--json', fixture, '127.0.0.2'];
  const { stdout } = await runDiagnostic(process.execPath, args, { env });
  const evidence = JSON.parse(stdout);
  assert.equal(evidence.verified, true);
  assert.equal(evidence.mode, 'manual-ip');
  assert.equal(evidence.address, '127.0.0.2');
  assert.equal(evidence.origin, paired.origin);
  assert.ok(!stdout.includes('unused-fixture-token'));
  await writeFile(fixture, JSON.stringify({ ...paired, serverId: randomUUID() }));
  await assert.rejects(runDiagnostic(process.execPath, args, { env }), error =>
    error.code === 1 && JSON.parse(error.stdout).verified === false && !JSON.parse(error.stdout).address);

});


test('address changes replace the advertisement and shutdown cancels further refresh', async () => {
  const paired = { serverId: randomUUID(), origin: 'https://warehouse.local' };
  let address = '192.168.10.20';
  const events = [];
  const maintained = maintainWarehouseAdvertisement(discoveryRecord(paired), {
    interfaces: () => ({ lan: [{ address, internal: false }] }),
    start: () => {
      const published = address;
      events.push('up:' + published);
      return { async close() { events.push('down:' + published); } };
    },
  });
  await maintained.refresh();
  address = '192.168.10.21';
  await Promise.all([maintained.refresh(), maintained.refresh()]);
  await maintained.close();
  await maintained.refresh();
  assert.deepEqual(events, ['up:192.168.10.20', 'down:192.168.10.20', 'up:192.168.10.21', 'down:192.168.10.21']);
});
