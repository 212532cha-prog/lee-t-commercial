const bridge = globalThis.LeeTWarehouse;
let sequence = 0;
const pending = new Map();

if (bridge) {
  globalThis.leetNativeReceive = (id, type, status, body) => {
    pending.get(id)?.(type, status, body);
  };
}

export function warehouseFetch(path, options) {
  if (!bridge) return fetch(path, options);
  const { method, headers, body, signal } = options;
  if (body !== undefined && typeof body !== 'string') return Promise.reject(Error('Unsupported mobile request'));
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const id = String(++sequence);
    const complete = () => {
      pending.delete(id);
      signal?.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      complete();
      reject(signal.reason);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    pending.set(id, (type, status, payload) => {
      complete();
      if (type !== 'response') reject(Error('Warehouse connection failed'));
      else resolve({ status, ok: status >= 200 && status < 300, json: async () => JSON.parse(payload) });
    });
    try {
      bridge.request(id, method, path, body ?? null, headers['X-CSRF-Token'] ?? null);
    } catch (error) {
      complete();
      reject(error);
    }
  });
}

export function warehouseEvents(path) {
  if (!bridge) return new EventSource(path);
  const id = String(++sequence);
  const channel = {
    onmessage: null,
    onerror: null,
    close() {
      if (pending.delete(id)) bridge.closeEvents(id);
    },
  };
  pending.set(id, (type, _status, payload) => {
    if (type === 'event') channel.onmessage?.({ data: payload });
    else {
      pending.delete(id);
      channel.onerror?.();
    }
  });
  queueMicrotask(() => {
    if (!pending.has(id)) return;
    try {
      bridge.events(id, path);
    } catch {
      pending.delete(id);
      channel.onerror?.();
    }
  });
  return channel;
}
