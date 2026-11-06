import { installLocalLicense, localActivationRequest } from '../src/commercial/server-license.mjs';
import { readSettings } from '../src/runtime/config.mjs';

try {
  const [command, source, ...extra] = process.argv.slice(2);
  if (extra.length || !(command === 'request' && !source || command === 'install' && source)) {
    throw Error('Usage: node scripts/lee-t-license.mjs request | install <signed-license.json>');
  }
  const settings = await readSettings();
  if (command === 'request') {
    console.log(JSON.stringify(await localActivationRequest(settings, { initialize: true }), null, 2));
  } else {
    await installLocalLicense(settings, source);
    console.log('Lee T license installed.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
