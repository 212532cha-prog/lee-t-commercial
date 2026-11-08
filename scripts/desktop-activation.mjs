import { createDesktopActivation, readDesktopActivationInput } from '../src/commercial/desktop-activation.mjs';
import { readSettings } from '../src/runtime/config.mjs';

// The desktop host supplies one bounded JSON envelope through stdin and closes it.
// Configuration is inherited from the protected installation, never from the envelope.
let result;
try {
  if (process.argv.length !== 2) throw Error('INVALID_REQUEST');
  const input = await readDesktopActivationInput(process.stdin);
  const activate = createDesktopActivation(await readSettings());
  result = await activate(input);
} catch { result = { schema: 1, ok: false, error: 'INVALID_REQUEST' }; }
process.stdout.write(JSON.stringify(result) + '\n');
if (!result.ok) process.exitCode = 1;
