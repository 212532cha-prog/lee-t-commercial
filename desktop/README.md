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

`node --test tests/commercial-desktop-activation.test.mjs` covers offline activation, altered/wrong-device refusal with byte-for-byte license preservation, online signing, operation overlap, stable installation identity, input bounds, hostile fields and the actual child process's output/exit behavior. This protocol is not yet connected to the native window or the installer. Production cloud signing configuration remains a separate acceptance gate.
