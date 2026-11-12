const bridge = globalThis.LeeTWarehouse;
let sequence = 0;
const pending = new Map();

if (bridge) {
  globalThis.leetNativeReceive = (id, type, status, body) => {
    pending.get(id)?.(type, status, body);
  };
}

export const nativeWorkspace = !!bridge;
export const administratorEntry = !!bridge && bridge.entryRole?.() === 'admin';
export function offlineStatus() {
  try { return JSON.parse(bridge?.offlineStatus?.() || '{}'); } catch { return {}; }
}
export function syncOfflineInventory() { bridge?.syncInventory?.(); }
export function closeWorkspace() { bridge?.closeWorkspace?.(); }

function nativeCall(send, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const id = String(++sequence);
    const complete = () => { pending.delete(id); signal?.removeEventListener('abort', cancel); };
    const cancel = () => { complete(); reject(signal.reason); };
    signal?.addEventListener('abort', cancel, { once: true });
    pending.set(id, (type, status, payload) => {
      complete();
      if (type !== 'response') reject(Error('Warehouse connection failed'));
      else resolve({ status, ok: status >= 200 && status < 300, json: async () => JSON.parse(payload) });
    });
    try { send(id); } catch (error) { complete(); reject(error); }
  });
}

export async function warehouseUpload(path, file, { headers = {}, signal, progress = () => {} } = {}) {
  if (!bridge) throw Error('Native upload unavailable');
  const type = headers['Content-Type'] || 'application/octet-stream';
  const upload = bridge.beginUpload(path, type, file.size, headers['X-CSRF-Token'] ?? null);
  try {
    for (let offset = 0; offset < file.size; offset += 256 * 1024) {
      if (signal?.aborted) throw signal.reason;
      const bytes = new Uint8Array(await file.slice(offset, offset + 256 * 1024).arrayBuffer());
      let binary = '';
      for (let start = 0; start < bytes.length; start += 4096) binary += String.fromCharCode(...bytes.subarray(start, start + 4096));
      bridge.appendUpload(upload, offset, btoa(binary));
      progress(Math.round(Math.min(file.size, offset + bytes.length) / file.size * 90));
    }
    const response = await nativeCall(id => bridge.finishUpload(id, upload), signal);
    progress(100);
    return response;
  } finally { bridge.cancelUpload(upload); }
}

export function warehouseFetch(path, options = {}) {
  if (!bridge) return fetch(path, options);
  const { method = 'GET', headers = {}, body, signal } = options;
  if (body instanceof Blob) return warehouseUpload(path, body, { headers, signal });
  if (body !== undefined && typeof body !== 'string') return Promise.reject(Error('Unsupported mobile request'));
  return nativeCall(id => {
    const extra = {};
    for (const key of ['X-Confirm-Permanent', 'X-Import-Preview']) if (headers[key]) extra[key] = headers[key];
    if (bridge.requestWithHeaders) bridge.requestWithHeaders(id, method, path, body ?? null, headers['X-CSRF-Token'] ?? null, JSON.stringify(extra));
    else bridge.request(id, method, path, body ?? null, headers['X-CSRF-Token'] ?? null);
  }, signal);
}

export async function warehouseDownload(path, print = false, signal) {
  if (!bridge) throw Error('Native download unavailable');
  const response = await nativeCall(id => bridge.download(id, path, print), signal);
  if (!response.ok) throw Error('File download failed');
  return response.json();
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
