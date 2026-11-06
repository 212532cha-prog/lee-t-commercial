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
    '-addext', 'subjectAltName=DNS:localhost,DNS:warehouse.example', '-keyout', 'key.pem', '-out', 'cert.pem'],
  { cwd: root, stdio: 'ignore' });
  const cert = await readFile(join(root, 'cert.pem'));
  const pin = new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase();
  let redirect = false;
  let requests = 0;
  const received = [];
  const cookie = '__Host-warehouse_session=fixture-session';
  const device = '__Host-leet_device=' + 'a'.repeat(43);
  server = createServer({ cert, key: await readFile(join(root, 'key.pem')) }, async (req, res) => {
    if (req.url === '/api/commercial/server-identity') {
      requests++;
      if (redirect) res.writeHead(302, { Location: '/unexpected' });
      res.end('{"schema":1}');
      return;
    }
    received.push(req.url);
    if (req.url === '/api/auth/login') {
      assert.equal(req.method, 'POST');
      assert.match(req.headers.origin, new RegExp('^https://(?:localhost|warehouse[.]example):'+server.address().port+'$'));
      assert.equal(req.headers['content-type'], 'application/json');
      let body = '';
      for await (const chunk of req) body += chunk;
      assert.equal(body, '{"username":"fixture"}');
      res.setHeader('Set-Cookie', [cookie + '; Path=/; Secure; HttpOnly', device + '; Path=/; Secure; HttpOnly']);
      res.end('{"csrf":"fixture-csrf"}');
    } else if (req.url === '/api/auth/device') {
      assert.equal(req.headers.cookie, device);
      res.end('{"device":true}');
    } else {
      assert.deepEqual(req.headers.cookie.split('; ').sort(), [cookie, device].sort());
      if (req.url === '/api/count/events?run=fixture') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.end(': ready\n\ndata: {"ready":true}\n\ndata: {"active":true}\n\n');
      } else if (req.url === '/api/stock/redirect') {
        res.writeHead(302, { Location: '/unexpected' });
        res.end();
      } else {
        assert.equal(req.method, 'POST');
        assert.equal(req.headers['x-csrf-token'], 'fixture-csrf');
        res.writeHead(409);
        res.end('{"error":"STOCK_CHANGED"}');
      }
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const harness = join(root, 'ProbeHarness.java');
  const implementation = await readFile(new URL('./android-source/WarehouseIdentityProbe.java', import.meta.url), 'utf8');
  const harnessSource = String.raw`public class ProbeHarness {
    public static void main(String[] args) throws Exception {
        if (args.length >= 3 && "api".equals(args[2])) {
            WarehouseApiTransport transport = new WarehouseApiTransport(args[0], args[1], args.length == 4 ? args[3] : null);
            WarehouseIdentityProbe.Response login = transport.request("POST", "/api/auth/login", "{\"username\":\"fixture\"}", null);
            System.out.println(login.status + ":" + login.body);
            WarehouseIdentityProbe.Response stock = transport.request("POST", "/api/stock/requests", "{}", "fixture-csrf");
            System.out.println(stock.status + ":" + stock.body);
            try (WarehouseApiTransport.Events events = transport.openEvents("/api/count/events?run=fixture")) {
                System.out.println(events.readEvent());
                System.out.println(events.readEvent());
            }
            try {
                transport.request("GET", "/api/stock/redirect", null, null);
                throw new AssertionError("Redirect followed");
            } catch (java.io.IOException expected) {
                System.out.println(expected.getMessage());
            }
            for (String path : new String[]{"/api/%2e%2e/unexpected", "//other.invalid/api/login"}) {
                try {
                    transport.request("GET", path, null, null);
                    throw new AssertionError("Invalid path accepted");
                } catch (IllegalArgumentException expected) {
                    System.out.println(expected.getMessage());
                }
            }
            WarehouseApiTransport reopened = new WarehouseApiTransport(args[0], args[1], args.length == 4 ? args[3] : null);
            reopened.restoreDevice(transport.deviceToken());
            System.out.println(reopened.request("GET", "/api/auth/device", null, null).body);
            return;
        }
        WarehouseIdentityProbe.Response result = WarehouseIdentityProbe.verify(args[0], args[1], args.length == 3 ? args[2] : null);
        System.out.println(result.status + ":" + result.body);
    }
}
`;
  const transport = await readFile(new URL('./android-source/WarehouseApiTransport.java', import.meta.url), 'utf8');
  const split = transport.indexOf('final class WarehouseApiTransport');
  const transportImports = transport.slice(0, split).split('\n').filter(line => line.startsWith('import '));
  const source = implementation.replace('import java.io.ByteArrayOutputStream;', transportImports.join('\n'));
  await writeFile(harness, (source + '\n' + transport.slice(split)).replace('final class WarehouseIdentityProbe', harnessSource + '\nfinal class WarehouseIdentityProbe'));
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
  const origin = new URL(url.replace('localhost', 'warehouse.example')).origin;
  redirect = false;
  const routeProbe = (host, fingerprint) => run('java', [
    harness, url.replace('localhost', host), fingerprint, '127.0.0.1',
  ], { timeout: 10000 });
  assert.equal((await routeProbe('warehouse.example', pin)).stdout.trim(), '200:{"schema":1}');
  await assert.rejects(routeProbe('other.example', pin), { stderr: /does not match the original host/ });
  const output = (await run('java', ['-Dsun.net.http.allowRestrictedHeaders=true', harness, origin, pin, 'api', '127.0.0.1'], { timeout: 10000 })).stdout.trim().split('\n');
  assert.deepEqual(output, [
    '200:{"csrf":"fixture-csrf"}', '409:{"error":"STOCK_CHANGED"}',
    '{"ready":true}', '{"active":true}', 'Warehouse API redirects are disabled',
    'Invalid warehouse API path', 'Invalid warehouse API path', '{"device":true}',
  ]);
  await assert.rejects(run('java', ['-Dsun.net.http.allowRestrictedHeaders=true', harness, origin, '0'.repeat(64), 'api', '127.0.0.1'], { timeout: 10000 }),
    { stderr: /does not match the pairing code/ });
  assert.deepEqual(received, ['/api/auth/login', '/api/stock/requests', '/api/count/events?run=fixture', '/api/stock/redirect', '/api/auth/device']);
  console.log('Android pinned transport verified identity, login cookies, stock errors, count events and redirect rejection.');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
