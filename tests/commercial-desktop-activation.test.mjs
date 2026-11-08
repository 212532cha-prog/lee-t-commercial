import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createDesktopActivation, readDesktopActivationInput } from '../src/commercial/desktop-activation.mjs';
import { generateIssuerKeyPair, issueLicense } from '../src/commercial/license.mjs';
import { requireLocalLicense } from '../src/commercial/server-license.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'leet-desktop-activation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const issuer = { ...generateIssuerKeyPair(), keyId: 'desktop-test' };
  const settings = { LEE_T_LICENSE_DIR: join(root, 'license'), LEE_T_ISSUER_PUBLIC_KEY_PATH: join(root, 'issuer.pem'),
    LEE_T_ISSUER_KEY_ID: issuer.keyId, LEE_T_ACTIVATION_ENDPOINT: 'https://issuer.example.test/activate' };
  await writeFile(settings.LEE_T_ISSUER_PUBLIC_KEY_PATH, issuer.publicKeyPem);
  const readDevice = async () => ({ machineId: 'desktop-one', boardId: 'board-one', systemDiskId: 'disk-one' });
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version;
  const sign = request => issueLicense({ ...issuer, request, customerId: 'test-customer', version });
  return { root, settings, readDevice, sign };
}
const command = (action, extra = {}) => ({ schema: 1, action, ...extra });

test('desktop offline flow preserves identity, verifies import and refuses wrong device/tampering without overwriting', async t => {
  const { root, settings, readDevice, sign } = await fixture(t);
  const bridge = createDesktopActivation(settings, { readDevice });
  assert.deepEqual(await bridge(command('status')), { schema: 1, ok: true, state: 'activation-required' });
  assert.deepEqual(await readdir(root), ['issuer.pem']); // Status is read-only, even on a fresh installation.
  const request = (await bridge(command('request'))).request;
  assert.deepEqual((await bridge(command('request'))).request, request);
  const license = sign(request);
  assert.deepEqual(await bridge(command('import', { license })), { schema: 1, ok: true, state: 'activated' });
  assert.equal((await bridge(command('status'))).state, 'activated');
  const stored = await readFile(join(settings.LEE_T_LICENSE_DIR, 'license.json'), 'utf8');
  const forged = structuredClone(license); forged.payload.customerId = 'forged';
  assert.equal((await bridge(command('import', { license: forged }))).error, 'LICENSE_REJECTED');
  const other = createDesktopActivation(settings, { readDevice: async () => ({ machineId: 'other', boardId: 'other', systemDiskId: 'other' }) });
  assert.equal((await other(command('import', { license }))).error, 'LICENSE_REJECTED');
  assert.equal((await other(command('status'))).state, 'activation-required');
  assert.equal(await readFile(join(settings.LEE_T_LICENSE_DIR, 'license.json'), 'utf8'), stored);
  assert.equal((await requireLocalLicense(settings, { readDevice })).valid, true);
  const newSettings = { ...settings, LEE_T_LICENSE_DIR: join(root, 'fresh') };
  assert.equal((await createDesktopActivation(newSettings, { readDevice })(command('import', { license }))).error, 'LICENSE_REJECTED');
  await assert.rejects(readFile(join(root, 'fresh', 'installation-id')), { code: 'ENOENT' });
});

test('desktop online flow uses installed trust, blocks competing operations and never returns secret exceptions', async t => {
  const { settings, readDevice, sign } = await fixture(t);
  let release, arrived;
  const waiting = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { arrived = resolve; });
  const code = 'LT-' + 'a'.repeat(32);
  const bridge = createDesktopActivation(settings, { readDevice, send: async (endpoint, options) => {
    assert.equal(endpoint.href, settings.LEE_T_ACTIVATION_ENDPOINT);
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body); assert.equal(body.code, code);
    arrived(); await waiting;
    return Response.json({ license: sign(body.request) });
  } });
  const pending = bridge(command('activate', { code }));
  await reached;
  assert.equal((await bridge(command('request'))).error, 'BUSY');
  release();
  assert.deepEqual(await pending, { schema: 1, ok: true, state: 'activated' });
  const stored = await readFile(join(settings.LEE_T_LICENSE_DIR, 'license.json'), 'utf8');
  const rejected = createDesktopActivation(settings, { readDevice, send: async () => { throw Error('secret-code private-key database-password'); } });
  assert.deepEqual(await rejected(command('activate', { code })), { schema: 1, ok: false, error: 'ACTIVATION_FAILED' });
  assert.equal((await rejected(command('status'))).state, 'activated');
  assert.equal(await readFile(join(settings.LEE_T_LICENSE_DIR, 'license.json'), 'utf8'), stored);
});

test('desktop protocol rejects unknown fields, prototype names, malformed UTF8, multiple messages and actual oversized bytes', async () => {
  let reads = 0;
  const bridge = createDesktopActivation({}, { readDevice: async () => { reads++; throw Error('hardware-secret'); } });
  for (const input of [null, [], {}, command('__proto__'), command('constructor'), command('request', { settings: {} }),
    command('activate', { code: 'bad' }), command('activate'), command('import', { license: [] }), command('request', { path: 'arbitrary' })]) {
    assert.equal((await bridge(input)).ok, false);
  }
  assert.equal(reads, 0);
  assert.deepEqual(await bridge(command('request')), { schema: 1, ok: false, error: 'DEVICE_REQUEST_FAILED' });
  for (const chunks of [[Buffer.from([0xff])], ['{}\n{}'], ['"' + '界'.repeat(6000) + '"']]) {
    await assert.rejects(readDesktopActivationInput(Readable.from(chunks)));
  }
  assert.deepEqual(await readDesktopActivationInput(Readable.from(['{"schema":1,', '"action":"status"}'])), command('status'));
});

test('desktop helper child process emits one bounded generic response without input or configuration in logs', async () => {
  for (const [input, args] of [['private-secret', []], ['{}', ['private-secret']], ['x'.repeat(16385), []],
    [JSON.stringify(command('request', { LEE_T_ACTIVATION_ENDPOINT: 'https://attacker.invalid' })), []]]) {
    const environment = { ...process.env, WAREHOUSE_CONFIG_PATH: '' };
    // A clean desktop helper does not inherit the developer runner's experimental proxy bootstrap.
    // Keep stderr assertions strict; do not hide runtime/application warnings.
    delete environment.NODE_USE_ENV_PROXY;
    const child = spawn(process.execPath, ['scripts/desktop-activation.mjs', ...args], {
      cwd: new URL('../', import.meta.url), env: environment, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', () => {});
    const done = once(child, 'close'); child.stdin.end(input);
    const [exit] = await done;
    assert.equal(exit, 1);
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), { schema: 1, ok: false, error: 'INVALID_REQUEST' });
    assert.equal(stdout.trim().split('\n').length, 1);
  }
});
