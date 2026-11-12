import { readFileSync, writeFileSync } from 'node:fs';

// An ephemeral CI certificate makes the real release variant installable for
// instrumentation. It is never the publisher key or a distributable signature.
if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.LEET_ACCEPTANCE_KEYSTORE) {
  throw Error('Release acceptance signing is restricted to an isolated CI runner.');
}
const path = new URL('./android/app/build.gradle', import.meta.url);
let gradle = readFileSync(path, 'utf8');
if (gradle.includes('// LEE T release acceptance')) throw Error('Release acceptance already configured.');
gradle = gradle.replace('    buildTypes {', `    // LEE T release acceptance
    testBuildType "release"
    signingConfigs {
        releaseAcceptance {
            storeFile file(System.getenv('LEET_ACCEPTANCE_KEYSTORE'))
            storePassword 'acceptance-only'
            keyAlias 'acceptance'
            keyPassword 'acceptance-only'
        }
    }
    buildTypes {`);
gradle = gradle.replace('        release {', `        release {
            signingConfig signingConfigs.releaseAcceptance`);
writeFileSync(path, gradle);
