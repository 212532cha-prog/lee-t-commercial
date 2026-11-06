import os from 'node:os';
import { request } from 'node:https';
import { isIP } from 'node:net';
import Bonjour from 'bonjour-service';
import { makeDiscoveryRecord } from './pairing.mjs';

const type = 'leet-warehouse';
export const identityPath = '/api/commercial/server-identity';

export function discoveryRecord({ serverId, origin }) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) throw Error('Discovery requires an HTTPS origin.');
  return makeDiscoveryRecord({ serverId, host: url.hostname, port: Number(url.port || 443) });
}

export function discoveryConfig(settings, pairing, listener) {
  if (settings.LEE_T_MDNS === undefined || settings.LEE_T_MDNS === '0') return null;
  if (settings.LEE_T_MDNS !== '1' || !pairing || !listener.tls ||
      !['0.0.0.0', '::'].includes(listener.bind)) {
    throw Error('LEE_T_MDNS requires commercial mode and a direct HTTPS LAN listener.');
  }
  return discoveryRecord(pairing);
}

export function advertiseWarehouse(record, { options, onError = () => {} } = {}) {
  os.networkInterfaces(); // Fail synchronously if the host cannot enumerate network adapters.
  const bonjour = new Bonjour(options, onError);
  try {
    const service = bonjour.publish({
      name: 'Lee T ' + record.serverId, type, protocol: 'tcp', host: record.host, port: record.port,
      txt: { id: record.serverId, v: '1' },
    });
    let closing;
    return {
      service,
      close() {
        return closing ??= new Promise(resolve => {
          bonjour.unpublishAll(() => bonjour.destroy(resolve));
        });
      },
    };
  } catch (error) {
    bonjour.destroy();
    throw error;
  }
}

// Connect to the advertised address while keeping the paired HTTPS hostname for SNI and certificate checks.
export function requestWarehouseIdentity(url, { address, signal, ca } = {}) {
  const family = isIP(address ?? '');
  return new Promise((resolve, reject) => {
    const req = request(url, {
      agent: false, signal, ca,
      ...(family && { family, lookup: (_hostname, _options, callback) => callback(null, address, family) }),
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('error', reject);
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 4096) res.destroy(Error('Server identity response is too large.'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({
        ok: res.statusCode === 200,
        json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function verifyWarehouseAddress(paired, address, { send = requestWarehouseIdentity, signal } = {}) {
  discoveryRecord(paired);
  if (!isIP(address ?? '')) throw Error('A valid server IP address is required.');
  const timeout = AbortSignal.timeout(5000);
  const response = await send(new URL(identityPath, paired.origin), {
    address, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) return null;
  const identity = await response.json();
  return identity?.schema === 1 && identity.serverId === paired.serverId ? paired.origin : null;
}

export async function verifyWarehouseCandidate(service, paired, options) {
  const record = discoveryRecord(paired);
  if (service?.type !== type || service.protocol !== 'tcp' ||
      service.txt?.v !== '1' || service.txt.id !== record.serverId ||
      service.host?.toLowerCase().replace(/\.$/, '') !== record.host || service.port !== record.port) {
    return null;
  }
  const addresses = [...new Set((service.addresses ?? []).filter(address => isIP(address)))].slice(0, 8);
  try {
    return await Promise.any(addresses.map(async address => {
      const origin = await verifyWarehouseAddress(paired, address, options);
      if (!origin) throw Error('Unexpected server identity.');
      return options?.includeAddress ? { origin, address } : origin;
    }));
  } catch {
    return null;
  }
}

export function findWarehouse(paired, { options, timeoutMs = 6000, send = requestWarehouseIdentity, includeAddress = false } = {}) {
  discoveryRecord(paired);
  if (!options?.interface) os.networkInterfaces();
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('Invalid discovery timeout.');
  return new Promise((resolve, reject) => {
    let browser, timer, finished = false;
    const controller = new AbortController();
    const bonjour = new Bonjour(options, error => finish(error));
    function finish(error, origin) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      controller.abort();
      browser?.stop();
      bonjour.destroy(() => error ? reject(error) : resolve(origin ?? null));
    }
    timer = setTimeout(() => finish(null), timeoutMs);
    browser = bonjour.find({ type, protocol: 'tcp' }, service => {
      verifyWarehouseCandidate(service, paired, { send, includeAddress, signal: controller.signal }).then(origin => {
        if (origin) finish(null, origin);
      }).catch(() => {}); // A candidate with bad TLS or identity is never selected.
    });
  });
}

export function maintainWarehouseAdvertisement(record, {
  start = advertiseWarehouse, interfaces = () => os.networkInterfaces(), intervalMs = 30000, onError = () => {},
} = {}) {
  const addressSet = () => Object.values(interfaces()).flat()
    .filter(item => !item.internal).map(item => item.address).sort().join(',');
  let addresses = addressSet();
  let advertisement = start(record, { onError });
  let stopped = false;
  let pending = Promise.resolve();
  const refresh = () => {
    pending = pending.then(async () => {
      if (stopped) return;
      const current = addressSet();
      if (current === addresses && advertisement) return;
      const previous = advertisement;
      advertisement = null;
      await previous?.close();
      if (stopped) return;
      advertisement = start(record, { onError });
      addresses = current;
    }).catch(onError);
    return pending;
  };
  const timer = setInterval(refresh, intervalMs);
  timer.unref();
  let closing;
  return {
    refresh,
    close() {
      stopped = true;
      clearInterval(timer);
      return closing ??= pending.then(() => advertisement?.close());
    },
  };
}
