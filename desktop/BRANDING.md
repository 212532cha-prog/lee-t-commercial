# Windows branding

`public/brand/lee-t.ico` packages the existing LEE T artwork at 16, 24, 32, 48, 64, 128 and 256 pixels. Regenerate it with `node scripts/build-brand-icon.mjs` after updating `public/brand/lee-t-logo.jpg`.

Both Windows projects embed it through `ApplicationIcon`; both installer scripts use it through `SetupIconFile`. Existing desktop shortcuts and uninstall entries already point to the installed EXE's first icon, so they use the embedded logo after the new build is installed. The warehouse window also loads the same icon resource.

The Windows desktop acceptance test compares the actual published EXE's extracted shell icon with the brand icon, in addition to checking the WPF window icon. Keep all existing activation, service recovery, session, permission and installer checks enabled.

## Release identity

Windows and Android warehouse display names are **LEE T Warehouse**; the issuer is **LEE T License Center**. Warehouse version 0.8.5 remains compatible with the existing offline entitlement; Android version code 80505 supports upgrades from 80504 with the same signing key. Windows assembly names, Android package ID, Inno AppIds and persistent data paths are intentionally retained.

The warehouse installer is `LEE-T-Warehouse-Setup.exe`, and the issuer installer is `LEE-T-License-Center-Setup.exe`. A production-signed Android deliverable should be named `LEE-T-Warehouse.apk`. Debug acceptance artifacts explicitly retain `debug` in their name. Android uses an adaptive icon with the original artwork contained inside its safe area. Installed package label/version/adaptive icon are checked on the emulator in addition to all existing workflow tests.

Branding does not certify a release: Windows Authenticode and a retained Android production signing key must be verified before distributing a signed commercial build. No release signing credentials are stored in this repository.
