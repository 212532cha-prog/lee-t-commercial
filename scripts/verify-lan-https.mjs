import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { get } from 'node:https';
import { isIPv4 } from 'node:net';
import { connect, createServer, rootCertificates } from 'node:tls';
import { pathToFileURL } from 'node:url';

export async function verifyLanHttps({ hostname, address, pfx, passphrase }, {
  resolve = lookup, ca = rootCertificates,
} = {}) {
  const dnsName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
  if (typeof hostname !== 'string' || hostname.length > 253 || !dnsName.test(hostname)) {
    throw Error('Use a fully qualified warehouse DNS hostname.');
  }
  if (!isIPv4(address)) throw Error('Use the warehouse server IPv4 address.');
  const addresses = await resolve(hostname, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some(record => record.address !== address)) {
    throw Error('The warehouse hostname must resolve only to the selected LAN IPv4.');
  }

  let server;
  try {
    server = createServer({ pfx, passphrase, minVersion: 'TLSv1.2' }, socket => socket.end());
  } catch {
    throw Error('The PFX file or its password is invalid.');
  }
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  try {
    await new Promise((resolveHandshake, reject) => {
      const client = connect({
        host: '127.0.0.1', port: server.address().port, servername: hostname,
        ca, rejectUnauthorized: true, minVersion: 'TLSv1.2',
      });
      client.once('error', reject);
      client.setTimeout(5000, () => client.destroy(Error('TLS handshake timed out.')));
      client.once('secureConnect', () => {
        const certificate = client.getPeerX509Certificate();
        if (!certificate?.checkHost(hostname, { subject: 'never' })) {
          client.destroy(Error('Certificate must identify the warehouse DNS hostname in its SAN.'));
          return;
        }
        client.destroy();
        resolveHandshake();
      });
    });
  } finally {
    await new Promise(resolveClose => server.close(resolveClose));
  }
}

export function probeWarehouseHttps(origin, expectedId, { ca = rootCertificates } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/commercial/server-identity', origin);
    if (url.protocol !== 'https:') throw Error('Use an HTTPS warehouse origin.');
    const request = get(url, { ca, signal: AbortSignal.timeout(5000) }, response => {
      const chunks = [];
      let size = 0;
      response.on('error', reject);
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 4096) response.destroy(Error('Unexpected warehouse identity response.'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const { schema, serverId } = JSON.parse(Buffer.concat(chunks));
          if (response.statusCode !== 200 || schema !== 1 || typeof expectedId !== 'string' || serverId !== expectedId) {
            throw Error('Unexpected warehouse identity response.');
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--probe') {
      await probeWarehouseHttps(process.argv[3], process.argv[4]);
    } else {
      let input = '';
      for await (const chunk of process.stdin.setEncoding('utf8')) input += chunk;
      const [hostname, address, path] = process.argv.slice(2);
      await verifyLanHttps({ hostname, address, pfx: await readFile(path), passphrase: Buffer.from(input.trim(), 'base64').toString('utf8') });
      process.stdout.write('Warehouse DNS and publicly trusted HTTPS certificate verified.\n');
    }
  } catch {
    if (process.argv[2] !== '--probe') process.stderr.write('Warehouse HTTPS validation failed. Check LAN DNS, certificate hostname, expiry, chain and PFX password.\n');
    process.exitCode = 1;
  }
}
