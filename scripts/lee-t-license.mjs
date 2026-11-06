import { installLocalLicense, localActivationRequest } from '../src/commercial/server-license.mjs';
import { activateOnline } from '../src/commercial/activation-client.mjs';
import { readSettings } from '../src/runtime/config.mjs';

try {
  const [command, source, ...extra] = process.argv.slice(2);
  if (extra.length || !(['request', 'activate'].includes(command) && !source || command === 'install' && source)) {
    throw Error('Usage: node scripts/lee-t-license.mjs request | install <signed-license.json> | activate < activation-code.txt');
  }
  const settings = await readSettings();
  if (command === 'request') {
    console.log(JSON.stringify(await localActivationRequest(settings, { initialize: true }), null, 2));
  } else if (command === 'activate') {
    let code = '';
    for await (const chunk of process.stdin) {
      code += chunk;
      if (code.length > 100) throw Error('Invalid activation code.');
    }
    await activateOnline(settings, code.trim());
    console.log('Lee T license activated and installed.');
  } else {
    await installLocalLicense(settings, source);
    console.log('Lee T license installed.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
