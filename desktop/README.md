# LEE T Windows App

The Windows client opens the bundled LEE T management workspace at `https://localhost:3443/admin/` in its own WebView2 window. It waits for the local warehouse identity endpoint, offers Retry when the service is unavailable, and retains the ordinary warehouse session on reload. It never launches an external browser. External navigation and unsolicited popups remain blocked; same-origin downloads use the Windows save dialog, and QR print pages open a child app window.

The Windows setup workflow builds the management bundle from the pinned RuoYi source, keeps RuoYi and jsQR licenses, validates a SHA-256 manifest, and stages the bundle into `app/management`. `Install-CommercialPayload.ps1` passes its validated absolute path into the protected warehouse service configuration. `start-app.mjs` checks that manifest before database startup. Missing or changed files reject startup rather than silently loading an incomplete interface. The manifest detects incomplete or changed files; it is not a digital signature or a replacement for signed distribution.

Build the desktop with `dotnet publish desktop/windows/LeeT.Desktop.csproj -c Release -r win-x64 --self-contained true`. Stage it with the bundled Node/PostgreSQL distributions, Microsoft-signed WebView2 installer and `Stage-CommercialPayload.ps1 -ManagementDirectory` pointing to the verified management output. The installer supplies runtime dependencies; the customer does not install Node.js or PostgreSQL separately.

`Test-Desktop.ps1` retains the existing unavailable-service, recovery, cookie reload and external-navigation checks. With `-ManagementDirectory`, it additionally starts an isolated native PostgreSQL 17 cluster, runs the actual warehouse services over locally trusted HTTPS, and tests the built management UI inside the real Windows app. It signs in, checks Administrator branding, opens all nine management module entries without failed API/script requests, and verifies session reload. No TLS bypass or test fallback is enabled. The Linux management workflow separately exercises all business flows against PostgreSQL, including real exports, backups and restores.

This remains a test installer: activation still uses a previously imported test license. The in-app customer activation flow, signed installer/update distribution, repair and upgrade acceptance, physical printers/cameras/LAN tests, and customer-machine verification remain release work. Automated Windows checks do not attest to the customer's installation or to mobile store approval.

## Private activation bridge

`scripts/desktop-activation.mjs` is the child-process foundation for the activation window. It does not expose a local web route or change startup/installer behavior. A native host must start the bundled Node executable directly (no shell), inherit the protected installation configuration, send exactly one JSON envelope on stdin, close stdin and collect the single JSON response. Activation codes must never be command-line arguments, log entries or environment variables. The host must serialize operations and bound/terminate child processes; it must not accept executable paths, trust settings or endpoint overrides from a web page.

| Input (`schema: 1`) | Successful output | Behavior |
| --- | --- | --- |
| `action: "status"` | `state: "activated"`, entitled `version`, or `state: "activation-required"` | Read-only license and hardware check; no new identity |
| `action: "request"` | `request` | Creates the installation ID once and exports hashed device claims for offline signing |
| `action: "activate", code` | `state: "activated"` | Existing HTTPS redemption with installed issuer trust and device/signature/version verification |
| `action: "import", license` | `state: "activated"` | Imports a signed JSON envelope for an already exported installation; never creates/rebinds identity |

Failures contain only a stable error code; hardware/connection/signature exceptions and submitted values are never returned or logged. Stdin is limited to 16 KiB of actual UTF-8 bytes, decoded strictly. Unknown actions and fields are refused, including attempts to supply configuration or file paths. Invalid imports and failed online requests preserve the existing license. Missing or invalid local licensing returns activation-required; it never unlocks the warehouse.

`node --test tests/commercial-desktop-activation.test.mjs` covers offline activation, altered/wrong-device refusal with byte-for-byte license preservation, online signing, operation overlap, stable installation identity, input bounds, hostile fields and the actual child process's output/exit behavior. The native activation window uses this protocol; the installer integration and production cloud signing remain separate acceptance gates.

## Installation permissions

The ordinary Windows app needs Users read/execute access to the installed program directory. Program modification stays restricted to administrators/SYSTEM; the warehouse service receives read/execute access. Private data, TLS and activation directories retain separate protected ACLs without a Users grant. The permission helper replaces existing explicit grants as well as removing inherited grants, so an old broad folder grant cannot survive protection.

`scripts/windows/Test-DirectoryPermissions.ps1` uses a disposable local standard account and an actual impersonated Windows token to check read/execute access, refuse program writes/injection and private configuration/license access, and confirm files remain unchanged. It also starts from existing explicit Users full-control grants. The account and files are removed in `finally`; production accounts and folders are never used by this test.

The private activation bridge belongs to an elevated setup/repair context that can read protected configuration and update licensing. The ordinary working app must not be elevated or receive database credentials just to open the warehouse workspace.

## Native activation window candidate

`LeeT.Warehouse.exe --activate` opens an English-first native WPF activation window without WebView2 or an external browser. Its only configuration location is `desktop/activation.private.json`. The entry requires administrator context, validates owner and write permissions of configuration, publisher public key, Node and bridge files and their parent directories, and refuses missing/untrusted settings. It cannot accept executable paths, endpoints or signing keys from command-line arguments or web content. `New-DesktopActivationConfig.ps1` prepares these settings for the future setup/repair caller; no database credentials are copied. An endpoint may be omitted for offline-only activation.

The window provides a masked purchase-key field, offline device-request export and signed JSON import with native Windows file dialogs. Busy operations disable mutation controls, keys are cleared after submission, and Continue is enabled only after a fresh local status check verifies the license. Exit 0 means verified activation was explicitly accepted; closing returns 10 and invalid setup returns 3. Ordinary app startup remains the existing unprivileged workspace.

The host starts only its bundled Node/bridge paths without a shell, transfers the envelope over stdin and allows only a small Windows environment plus the fixed configuration path into the child. It does not inherit Node injection, TLS overrides, database credentials or proxies. It serializes operations, bounds actual response bytes, validates exit/status agreement and enforces timeout/cancellation with child termination. Request export refuses installation and active-license locations.

Native Windows checks exercise the real bridge/signatures with an isolated test device and issuer, the rendered WPF controls, bad imports, false success, private configuration ACLs, hostile child environment, malformed/oversized output and timeout/cancellation cleanup. Preview PNGs are generated from the actual WPF window. The test-only issuer/device implementation lives under `desktop/tests`; the installed entry always selects the production bridge and Windows hardware reader.

This window is not yet invoked by the existing test-license installer. The next installation phase must supply embedded publisher trust, invoke activation during setup, handle cancellation/recovery and continue provisioning in the same flow. Actual hosted signing, release signing, full clean-machine installation and physical-device acceptance remain required; the candidate is not a commercial release.
