import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateIssuerKeyPair, issueLicense } from '../src/commercial/license.mjs';
import { installLocalLicense, localActivationRequest, requireLocalLicense } from '../src/commercial/server-license.mjs';

const device = { machineId: 'machine-a', boardId: 'board-a', systemDiskId: 'disk-a' };
const readDevice = async () => device;
const runningVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version;

test('offline activation is persistent, concurrent-safe and bound to the installation and device', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lee-t-license-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const issuer = generateIssuerKeyPair();
  const keyId = 'issuer-test';
  const settings = {
    LEE_T_LICENSE_DIR: join(directory, 'activation'),
    LEE_T_ISSUER_PUBLIC_KEY_PATH: join(directory, 'issuer-public.pem'),
    LEE_T_ISSUER_KEY_ID: keyId,
  };
  await writeFile(settings.LEE_T_ISSUER_PUBLIC_KEY_PATH, issuer.publicKeyPem);
  await assert.rejects(requireLocalLicense(settings, { readDevice }), { code: 'ENOENT' });
  const requestOptions = { initialize: true, readDevice };
  const [request, concurrent] = await Promise.all([
    localActivationRequest(settings, requestOptions),
    localActivationRequest(settings, requestOptions),
  ]);
  assert.deepEqual(concurrent, request);
  assert.equal(JSON.stringify(request).includes(device.machineId), false);

  const issue = (overrides = {}) => issueLicense({
    privateKeyPem: issuer.privateKeyPem, keyId, request, customerId: 'customer-a', version: runningVersion, ...overrides,
  });
  const input = join(directory, 'incoming.json');
  const license = issue();
  await writeFile(input, JSON.stringify(license));
  assert.equal((await installLocalLicense(settings, input, { readDevice })).licenseId, license.payload.licenseId);
  assert.equal((await requireLocalLicense(settings, { readDevice })).licenseId, license.payload.licenseId);
  assert.equal((await requireLocalLicense(settings, { readDevice: async () => ({ ...device, systemDiskId: 'disk-b' }) })).matchingDeviceClaims, 2);
  await assert.rejects(requireLocalLicense(settings, { readDevice: async () => ({ ...device, systemDiskId: 'disk-b', boardId: 'board-b' }) }), /fingerprint does not match/);

  const another = await localActivationRequest({ ...settings, LEE_T_LICENSE_DIR: join(directory, 'other') }, requestOptions);
  await writeFile(input, JSON.stringify(issue({ request: another })));
  await assert.rejects(installLocalLicense(settings, input, { readDevice }), /different installation/);
  await writeFile(input, JSON.stringify(issue({ version: '0.0.0' })));
  await assert.rejects(installLocalLicense(settings, input, { readDevice }), /version is not licensed/);
  await writeFile(input, JSON.stringify({ ...license, payload: { ...license.payload, customerId: 'tampered' } }));
  await assert.rejects(installLocalLicense(settings, input, { readDevice }), /signature mismatch/);
  assert.equal((await requireLocalLicense(settings, { readDevice })).licenseId, license.payload.licenseId);
  assert.deepEqual((await readdir(settings.LEE_T_LICENSE_DIR)).sort(), ['installation-id', 'license.json']);
});

test('commercial startup fails before connecting to the database without a local license', () => {
  const result = spawnSync(process.execPath, ['scripts/start-app.mjs', '--commercial'], {
    env: { DATABASE_URL: 'postgres://127.0.0.1:1/test', PUBLIC_ORIGIN: 'https://warehouse.test' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 1, result.error?.message);
  assert.match(result.stderr, /commercial startup requires a valid license/);
  assert.doesNotMatch(result.stdout, /Warehouse ready/);
});
