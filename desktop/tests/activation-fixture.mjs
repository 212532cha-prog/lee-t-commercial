// Test-only device/issuer implementation. The installed app always selects scripts/desktop-activation.mjs.
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { createDesktopActivation, readDesktopActivationInput } from '../../src/commercial/desktop-activation.mjs';
import { issueLicense } from '../../src/commercial/license.mjs';
import { readSettings } from '../../src/runtime/config.mjs';

const settings = await readSettings();
const mode = basename(process.env.WAREHOUSE_CONFIG_PATH);
if (Object.keys(process.env).some(key => /^(?:NODE_|PGPASSWORD$|DATABASE_URL$)/.test(key))) throw Error('Host environment was not isolated.');
if (mode.startsWith('hang')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await writeFile(join(dirname(settings.LEE_T_LICENSE_DIR), 'hanging-child-pid'), String(child.pid));
  await writeFile(join(dirname(settings.LEE_T_LICENSE_DIR), 'hanging-pid'), String(process.pid));
  await new Promise(() => setInterval(() => {}, 1000));
}
if (mode.startsWith('oversize')) { process.stdout.write('x'.repeat(20000)); process.exit(0); }
if (mode.startsWith('invalid-utf8')) { process.stdout.write(Buffer.from([0xff])); process.exit(0); }
if (mode.startsWith('bad-exit')) { process.stdout.write(JSON.stringify({ schema: 1, ok: false, error: 'secret-value' })); process.exit(0); }
const input = await readDesktopActivationInput(process.stdin);
const handle = createDesktopActivation(settings, {
  readDevice: async () => ({ machineId: 'ui-fixture-machine', boardId: 'ui-fixture-board', systemDiskId: 'ui-fixture-disk' }),
  send: async (_url, options) => {
    await new Promise(resolve => setTimeout(resolve, 100));
    const { request, code } = JSON.parse(options.body);
    if (code !== 'LT-' + 'a'.repeat(32)) return Response.json({}, { status: 403 });
    const version = JSON.parse(await readFile(new URL('../../package.json', import.meta.url))).version;
    return Response.json({ license: issueLicense({ privateKeyPem: await readFile(join(dirname(settings.LEE_T_LICENSE_DIR), 'test-signing-key'), 'utf8'),
      keyId: 'desktop-ui-test', request, customerId: 'isolated-ui-fixture', version }) });
  },
});
const result = await handle(input);
process.stdout.write(JSON.stringify(result) + '\n');
if (!result.ok) process.exitCode = 1;
