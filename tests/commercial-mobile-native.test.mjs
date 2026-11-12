import assert from 'node:assert/strict';
import test from 'node:test';

async function load(bridge) {
  globalThis.LeeTWarehouse = bridge;
  return import('../public/app/native-transport.js?case=' + Math.random());
}
const respond = (id, body = {}, status = 200) => queueMicrotask(() => globalThis.leetNativeReceive(id, 'response', status, JSON.stringify(body)));

test('native requests retain PATCH and permanent-delete confirmation without leaking arbitrary headers', async t => {
  t.after(() => { delete globalThis.LeeTWarehouse; delete globalThis.leetNativeReceive; });
  const calls = [];
  const m = await load({ requestWithHeaders(...args) { calls.push(args); respond(args[0], { ok: true }); } });
  const result = await m.warehouseFetch('/api/products/id', { method: 'PATCH', body: '{"name":"Updated"}',
    headers: { 'X-CSRF-Token': 'csrf', 'X-Confirm-Permanent': 'delete-product', Cookie: 'must-not-pass', Origin: 'must-not-pass' } });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].slice(1), ['PATCH', '/api/products/id', '{"name":"Updated"}', 'csrf', '{"X-Confirm-Permanent":"delete-product"}']);
});

test('native photo and backup uploads preserve every byte with bounded chunks and visible completion', async t => {
  t.after(() => { delete globalThis.LeeTWarehouse; delete globalThis.leetNativeReceive; });
  const parts = [], progress = [], started = [], cancelled = [];
  const m = await load({
    beginUpload(...args) { started.push(args); return 'upload'; },
    appendUpload(id, offset, encoded) { assert.equal(id, 'upload'); assert.equal(offset, Buffer.concat(parts).length); const bytes = Buffer.from(encoded, 'base64'); assert.ok(bytes.length <= 256 * 1024); parts.push(bytes); },
    finishUpload(id, upload) { assert.equal(upload, 'upload'); respond(id, { verified: true }, 201); },
    cancelUpload(id) { cancelled.push(id); },
  });
  const source = Uint8Array.from({ length: 700001 }, (_, i) => i % 251);
  const response = await m.warehouseUpload('/api/backups/upload', new Blob([source]), { headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': 'test' }, progress: value => progress.push(value) });
  assert.deepEqual(Buffer.concat(parts), Buffer.from(source));
  assert.deepEqual(started, [['/api/backups/upload', 'application/octet-stream', source.length, 'test']]);
  assert.equal(response.status, 201); assert.deepEqual(await response.json(), { verified: true });
  assert.equal(progress.at(-1), 100); assert.deepEqual(cancelled, ['upload']);
  parts.length = 0;
  await m.warehouseFetch('/api/me/avatar', { method: 'PUT', body: new Blob([source.subarray(0, 10)], { type: 'image/png' }), headers: { 'Content-Type': 'image/png' } });
  assert.deepEqual(Buffer.concat(parts), Buffer.from(source.subarray(0, 10)));
});

test('cancelled upload deletes staged data and never commits it', async t => {
  t.after(() => { delete globalThis.LeeTWarehouse; delete globalThis.leetNativeReceive; });
  const controller = new AbortController(), cancelled = [];
  const m = await load({ beginUpload: () => 'staged', appendUpload() { controller.abort(); },
    finishUpload() { assert.fail('Cancelled upload must not be sent'); }, cancelUpload: id => cancelled.push(id) });
  await assert.rejects(m.warehouseUpload('/api/backups/upload', new Blob([new Uint8Array(500000)]), { signal: controller.signal }), error => error.name === 'AbortError');
  assert.deepEqual(cancelled, ['staged']);
});

test('native response cancellation ignores late writes and never automatically replays them', async t => {
  t.after(() => { delete globalThis.LeeTWarehouse; delete globalThis.leetNativeReceive; });
  let called = 0, sent;
  const m = await load({ request(id) { called++; sent = id; } });
  const controller = new AbortController();
  const result = m.warehouseFetch('/api/stock/transactions', { method: 'POST', body: '{}', signal: controller.signal });
  controller.abort();
  await assert.rejects(result, error => error.name === 'AbortError');
  globalThis.leetNativeReceive(sent, 'response', 200, '{}');
  assert.equal(called, 1);
});

test('download cancellation and native failures stay distinguishable from a saved file', async t => {
  t.after(() => { delete globalThis.LeeTWarehouse; delete globalThis.leetNativeReceive; });
  let fail = false;
  const m = await load({ download(id, path, print) { assert.equal(path, '/api/backups/download-full'); assert.equal(print, false); if (fail) queueMicrotask(() => globalThis.leetNativeReceive(id, 'error', 0, '')); else respond(id, { cancelled: true }); } });
  assert.deepEqual(await m.warehouseDownload('/api/backups/download-full'), { cancelled: true });
  fail = true;
  await assert.rejects(m.warehouseDownload('/api/backups/download-full'), /connection failed/);
});
