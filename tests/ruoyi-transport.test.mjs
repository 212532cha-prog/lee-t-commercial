import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminTransport } from '../integrations/ruoyi-vue3/src/views/leet/warehouse-api.mjs';

test('RuoYi transport bounds an unconfirmed write without retrying it', { timeout: 1000 }, async () => {
  const calls = [];
  const transport = createAdminTransport({
    timeoutMs: 20,
    request(path, options) {
      calls.push(path);
      if (path === '/api/me') return Promise.resolve(Response.json({ user: { role: 'admin' }, csrf: 'test-only' }));
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    },
  });
  await assert.rejects(transport.write('/api/employees', { method: 'POST', data: { realName: 'Test employee' } }), error => error.name === 'AbortError');
  assert.deepEqual(calls, ['/api/me', '/api/employees']);
});

test('RuoYi transport propagates page cancellation to the active request', { timeout: 1000 }, async () => {
  const controller = new AbortController();
  let aborted = false;
  const transport = createAdminTransport({
    request(_path, options) {
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => {
        aborted = true;
        reject(options.signal.reason);
      }, { once: true }));
    },
  });
  const pending = transport.read('/api/employees', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(aborted, true);
});
