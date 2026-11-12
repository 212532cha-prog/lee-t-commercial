# Windows branding

`public/brand/lee-t.ico` packages the existing LEE T artwork at 16, 24, 32, 48, 64, 128 and 256 pixels. Regenerate it with `node scripts/build-brand-icon.mjs` after updating `public/brand/lee-t-logo.jpg`.

Both Windows projects embed it through `ApplicationIcon`; both installer scripts use it through `SetupIconFile`. Existing desktop shortcuts and uninstall entries already point to the installed EXE's first icon, so they use the embedded logo after the new build is installed. The warehouse window also loads the same icon resource.

The Windows desktop acceptance test compares the actual published EXE's extracted shell icon with the brand icon, in addition to checking the WPF window icon. Keep all existing activation, service recovery, session, permission and installer checks enabled.
