import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createEmulatorFixture } from './emulator-fixture.mjs';
const fixture = await createEmulatorFixture();
try {
  const args = ['--no-daemon', 'connectedDebugAndroidTest', ...Object.entries(fixture.arguments)
    .filter(([key]) => key !== 'invitation').map(([key, value]) => '-Pandroid.testInstrumentationRunnerArguments.' + key + '=' + value)];
  const child = spawn('./gradlew', args, { cwd: new URL('./android/', import.meta.url), stdio: 'inherit' });
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) throw Error('Packaged Android tests failed: ' + (signal || code));
} finally { await fixture.close(); }
