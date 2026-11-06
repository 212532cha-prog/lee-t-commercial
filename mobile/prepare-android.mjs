import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./node_modules/@capacitor/cli/bin/capacitor', import.meta.url));
const run = (...args) => execFileSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
if (!existsSync('android/variables.gradle')) run('add', 'android');
const file = 'android/variables.gradle';
const original = readFileSync(file, 'utf8');
const match = /^\s*minSdkVersion\s*=\s*(\d+)\s*$/m.exec(original);
if (!match) throw Error('Cannot locate Android minimum SDK configuration.');
if (Number(match[1]) < 26) {
  writeFileSync(file, original.replace(/(minSdkVersion\s*=\s*)\d+/, (_match, prefix) => prefix + '26'));
}
const main = 'android/app/src/main';
const manifestPath = main + '/AndroidManifest.xml';
const manifest = readFileSync(manifestPath, 'utf8');
const networkConfig = 'android:networkSecurityConfig="@xml/leet_network_security"';
if (!manifest.includes(networkConfig)) {
  if (!manifest.includes('<application') || manifest.includes('android:networkSecurityConfig=')) {
    throw Error('Cannot configure Android network security.');
  }
  writeFileSync(manifestPath, manifest.replace('<application', '<application ' + networkConfig));
}
let workspaceManifest = readFileSync(manifestPath, 'utf8');
if (!workspaceManifest.includes('android:name=".WarehouseActivity"')) {
  workspaceManifest = workspaceManifest.replace('</application>',
    '<activity android:name=".WarehouseActivity" android:exported="false" />\n    </application>');
}
if (!workspaceManifest.includes('android:name="android.permission.CAMERA"')) {
  workspaceManifest = workspaceManifest.replace('</manifest>',
    '    <uses-permission android:name="android.permission.CAMERA" />\n</manifest>');
}
writeFileSync(manifestPath, workspaceManifest);
const java = main + '/java/my/leet/warehouse';
for (const name of ['MainActivity.java', 'WarehouseActivity.java', 'WarehouseIdentityProbe.java', 'WarehouseApiTransport.java', 'PinnedWorkspace.java', 'WarehouseWorkspacePlugin.java']) {
  copyFileSync('android-source/' + name, java + '/' + name);
}
mkdirSync(main + '/res/xml', { recursive: true });
copyFileSync('network-security.xml', main + '/res/xml/leet_network_security.xml');
run('sync', 'android');

const workspaceAssets = main + '/assets/warehouse';
mkdirSync(workspaceAssets + '/vendor', { recursive: true });
mkdirSync(workspaceAssets + '/fonts', { recursive: true });
for (const name of ['index.html', 'app.css', 'app.js', 'admin.js', 'backup.js', 'catalog.js', 'count.js',
  'native-transport.js', 'pairing.js', 'qr-print.js', 'stock.js']) {
  copyFileSync('../public/app/' + name, workspaceAssets + '/' + name);
}
copyFileSync('../node_modules/jsqr/dist/jsQR.js', workspaceAssets + '/vendor/jsqr.js');
copyFileSync('../node_modules/@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-400-normal.woff2',
  workspaceAssets + '/fonts/business-regular.woff2');
