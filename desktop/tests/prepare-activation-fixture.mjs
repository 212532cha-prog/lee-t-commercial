import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateIssuerKeyPair, issueLicense } from '../../src/commercial/license.mjs';

const [directory, command, source] = process.argv.slice(2);
if (command === 'prepare') {
  const keys = generateIssuerKeyPair();
  await writeFile(join(directory, 'issuer.pem'), keys.publicKeyPem);
  await writeFile(join(directory, 'test-signing-key'), keys.privateKeyPem, { mode: 0o600, flag: 'wx' });
} else if (command === 'sign') {
  const version = JSON.parse(await readFile(new URL('../../package.json', import.meta.url))).version;
  const license = issueLicense({ privateKeyPem: await readFile(join(directory, 'test-signing-key'), 'utf8'),
    keyId: 'desktop-ui-test', request: JSON.parse(await readFile(source, 'utf8')), customerId: 'isolated-ui-fixture', version });
  await writeFile(join(directory, 'license-to-import.json'), JSON.stringify(license));
} else throw Error('Invalid fixture command.');
