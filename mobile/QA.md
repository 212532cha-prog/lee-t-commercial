# Android mobile acceptance

Version: `0.8.5` (version code `80505`), package `my.leet.warehouse`, minimum Android API 26.

The Android workflow retains an APK only after the packaged WebView tests pass. It never uses `continue-on-error` for build, transport, or instrumentation checks. The complete repository CI separately runs on Node 22 and 24 with PostgreSQL 17.

## Required automated checks

- `npm run lint`, `npm run scan:secrets`, `npm test`.
- Browser pairing at 320 pixels: camera permission recovery, cancellation, pinned discovery, direct administrator entry, separate employee/admin identities, all three languages, offline read-only content, safe rendering, clear saved access and retry after failure.
- Native bridge: PATCH and explicit deletion headers, byte-exact bounded uploads, import preview proof, cancellation, late responses, no automatic replay of stock writes, distinguish cancelled and saved files.
- `node mobile/test-identity-probe.mjs --warehouse`: real Java TLS transport, SAN and certificate mismatch rejection, redirects blocked, cookie ownership, actual employee pairing, stock idempotency and live stocktake.
- `node mobile/run-emulator-tests.mjs`, with an emulator already running: the actual APK and bundled assets connect through JavascriptInterface and pinned TLS to an isolated PostgreSQL warehouse.
- Instrumentation checks administrator authentication through both entrances; encrypted session persistence, certificate isolation, expiry and tamper rejection; product PATCH/photo/QR; stock in/out; module navigation; profile edits; document saving; XLSX generation; backup download/upload validation; connection interruption/retry; employee pairing and permissions; live count submission without changing stock; administrator sign-out and translations.
- Preserve the generated package-identity test with the actual application ID; do not remove the assertion.
- Verify APK signature and package identity before uploading the artifact.

The test fixture's control endpoint exists only in `emulator-fixture.mjs`. It is not part of the production server or bundled APK. Tests issue fresh employee invitations rather than lengthening the production expiry.

## Device acceptance remaining

Automated emulator checks do not prove camera autofocus, real QR recognition under workshop lighting, OEM permission screens, Wi-Fi/mDNS behavior on the user's router, or a physical printer. Verify these on the target phone before describing the build as fully accepted for sale. In particular, scan both connection QR types, perform one real product scan for each business flow, disable Wi-Fi and view the timestamped saved inventory, then reconnect.

The existing workflow builds a debug-signed APK. It is not a store release signed with a retained owner publishing key. Replacing an older APK signed with another key may require uninstalling the phone app, which removes phone pairing/session/offline cache. Warehouse data remains on its computer. Do not advise deleting the warehouse database or issuer keys to update the phone app.
