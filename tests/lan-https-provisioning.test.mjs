import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { probeWarehouseHttps, verifyLanHttps } from '../scripts/verify-lan-https.mjs';

test('LAN HTTPS preflight verifies DNS, PFX, trust and the DNS SAN through a real TLS handshake', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'leet-lan-https-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const openssl = (...args) => execFileSync('openssl', args, { cwd, stdio: 'ignore' });
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=Fixture CA', '-keyout', 'ca.key', '-out', 'ca.pem');
  openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=warehouse.example',
    '-addext', 'subjectAltName=DNS:warehouse.example,DNS:localhost', '-keyout', 'leaf.key', '-out', 'leaf.csr');
  openssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
    '-copy_extensions', 'copy', '-days', '1', '-out', 'leaf.pem');
  openssl('pkcs12', '-export', '-inkey', 'leaf.key', '-in', 'leaf.pem',
    '-certfile', 'ca.pem', '-passout', 'pass:fixture', '-out', 'server.pfx');
  const input = { hostname: 'warehouse.example', address: '192.168.0.97', passphrase: 'fixture',
    pfx: await readFile(join(cwd, 'server.pfx')) };
  const ca = await readFile(join(cwd, 'ca.pem'));
  const resolve = async () => [{ address: input.address, family: 4 }];
  await verifyLanHttps(input, { resolve, ca });
  await assert.rejects(verifyLanHttps(input, { resolve }), /self.signed|issuer|verify/i);
  await assert.rejects(verifyLanHttps({ ...input, hostname: 'different.example' }, { resolve, ca }),
    { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  await assert.rejects(verifyLanHttps({ ...input, passphrase: 'wrong' }, { resolve, ca }), /password/i);
  await assert.rejects(verifyLanHttps(input, { ca, resolve: async () => [
    { address: input.address }, { address: '192.168.0.98' },
  ] }), /resolve only/);
  await assert.rejects(verifyLanHttps({ ...input, hostname: input.address }, { resolve, ca }),
    /DNS hostname/);

  const serverId = 'ea22be68-6bda-4c66-90be-a29175dd34f6';
  const live = createServer({ pfx: input.pfx, passphrase: input.passphrase }, (request, response) => {
    assert.equal(request.url, '/api/commercial/server-identity');
    response.end(JSON.stringify({ schema: 1, serverId }));
  });
  live.listen(0, '127.0.0.1');
  await once(live, 'listening');
  try {
    const origin = 'https://localhost:' + live.address().port;
    await probeWarehouseHttps(origin, serverId, { ca });
    await assert.rejects(probeWarehouseHttps(origin, 'unexpected', { ca }), /identity response/);
    await assert.rejects(probeWarehouseHttps(origin, serverId), /self.signed|issuer|verify/i);
  } finally {
    await new Promise(resolveClose => live.close(resolveClose));
  }
});
