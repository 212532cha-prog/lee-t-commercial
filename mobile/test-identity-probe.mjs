import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'leet-android-pin-'));
let server;
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'basicConstraints=critical,CA:FALSE',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', 'key.pem', '-out', 'cert.pem'],
  { cwd: root, stdio: 'ignore' });
  const cert = await readFile(join(root, 'cert.pem'));
  const pin = new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase();
  let redirect = false;
  let requests = 0;
  server = createServer({ cert, key: await readFile(join(root, 'key.pem')) }, (req, res) => {
    requests++;
    assert.equal(req.url, '/api/commercial/server-identity');
    if (redirect) res.writeHead(302, { Location: '/unexpected' });
    res.end('{"schema":1}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const harness = join(root, 'ProbeHarness.java');
  const implementation = await readFile(new URL('./android-source/WarehouseIdentityProbe.java', import.meta.url), 'utf8');
  const harnessSource = `public class ProbeHarness {
    public static void main(String[] args) throws Exception {
        WarehouseIdentityProbe.Response result = WarehouseIdentityProbe.verify(args[0], args[1]);
        System.out.println(result.status + ":" + result.body);
    }
}
`;
  await writeFile(harness, implementation.replace('final class WarehouseIdentityProbe', harnessSource + '\nfinal class WarehouseIdentityProbe'));
  const url = `https://localhost:${server.address().port}/api/commercial/server-identity`;
  const probe = (address, fingerprint) =>
    run('java', [harness, address, fingerprint], { timeout: 10000 });
  assert.equal((await probe(url, pin)).stdout.trim(), '200:{"schema":1}');
  await assert.rejects(probe(url, '0'.repeat(64)), { stderr: /does not match the pairing code/ });
  await assert.rejects(probe(url.replace('localhost', '127.0.0.1'), pin), { stderr: /subject alternative|No name matching/i });
  await assert.rejects(probe(url + '?token=fixture', pin), { stderr: /Invalid warehouse identity endpoint/ });
  assert.equal(requests, 1);
  redirect = true;
  assert.equal((await probe(url, pin)).stdout.trim(), '302:null');
  assert.equal(requests, 2);
  console.log('Android identity probe verified the exact certificate, hostname, request path and redirect rejection.');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
