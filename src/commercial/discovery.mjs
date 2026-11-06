import os from 'node:os';
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

export async function verifyWarehouseCandidate(service, paired, { send = fetch } = {}) {
  const record = discoveryRecord(paired);
  if (service?.type !== type || service.protocol !== 'tcp' ||
      service.txt?.v !== '1' || service.txt.id !== record.serverId ||
      service.host?.toLowerCase().replace(/\.$/, '') !== record.host || service.port !== record.port) {
    return null;
  }
  const response = await send(new URL(identityPath, paired.origin), {
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return null;
  const identity = await response.json();
  return identity.schema === 1 && identity.serverId === record.serverId ? paired.origin : null;
}

export function findWarehouse(paired, { options, timeoutMs = 6000, send = fetch } = {}) {
  discoveryRecord(paired);
  if (!options?.interface) os.networkInterfaces();
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('Invalid discovery timeout.');
  return new Promise((resolve, reject) => {
    let browser, timer, finished = false;
    const bonjour = new Bonjour(options, error => finish(error));
    function finish(error, origin) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      browser?.stop();
      bonjour.destroy(() => error ? reject(error) : resolve(origin ?? null));
    }
    timer = setTimeout(() => finish(null), timeoutMs);
    browser = bonjour.find({ type, protocol: 'tcp' }, service => {
      verifyWarehouseCandidate(service, paired, { send }).then(origin => {
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
