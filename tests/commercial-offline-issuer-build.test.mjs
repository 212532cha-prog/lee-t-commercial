import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('offline installer staging accepts only a canonical Ed25519 public key and safe issuer ID', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'leet-offline-issuer-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const encoded = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const script = fileURLToPath(new URL('../scripts/windows/prepare-offline-issuer.mjs', import.meta.url));
  const run = (key, id) => spawnSync(process.execPath, [script, folder], {
    encoding: 'utf8', env: { ...process.env, LEE_T_OFFLINE_ISSUER_PUBLIC_KEY: key, LEE_T_OFFLINE_ISSUER_KEY_ID: id },
  });
  for (const [key, id] of [
    [privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), 'publisher-1'],
    [generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), 'publisher-1'],
    [encoded, "publisher'1"], [encoded, ''], ['', 'publisher-1'],
  ]) {
    const result = run(key, id);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), 'Provide an Ed25519 SPKI public key in base64 and a valid issuer key ID.');
    assert.deepEqual(await readdir(folder), []);
  }
  assert.equal(run(encoded, 'publisher-1').status, 0);
  assert.equal(await readFile(join(folder, 'issuer-public.pem'), 'utf8'), publicKey.export({ format: 'pem', type: 'spki' }));
  assert.equal(await readFile(join(folder, 'issuer-id.txt'), 'utf8'), 'publisher-1');
  assert.equal(run(encoded, 'publisher-2').status, 1);
  assert.equal(await readFile(join(folder, 'issuer-id.txt'), 'utf8'), 'publisher-1');
});
