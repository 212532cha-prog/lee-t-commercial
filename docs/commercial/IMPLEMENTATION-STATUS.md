# Lee T Commercial Edition — implementation status (2026-11-06)

## Source baseline

- Source: `warehouse-inventory-0.8.5-candidate.zip` supplied by product owner.
- Existing LEE T Warehouse business code is retained; no existing tests deleted or weakened.
- Two Chinese-document filenames were restored from the original ZIP using Python `zipfile`, because system `unzip` mangled the names. This is a packaging/extraction repair, not a changed acceptance test.

## Implemented here

- `src/commercial/license.mjs`: Ed25519 signed offline license issue/verify primitives, device request with hashed hardware claims, exact installation identity, two-of-three hardware claim matching, version entitlement checks, key ID allowlist.
- `src/commercial/license-center.mjs`: local **pilot-only** single-process file-backed creation/redemption of high-entropy single-use codes after explicit payment confirmation. Hashes codes at rest, serializes concurrent redemptions and records basic audit entries. NOT a public cloud service or production multi-instance safe ledger.
- `src/commercial/pairing.mjs`: mDNS service descriptor data and expiring, single-use pairing invitation primitives. NOT actual mDNS broadcasting, HTTP routing, TLS authentication or an employee app.
- 13 new tests in `tests/commercial-*.test.mjs`.

## Open items at the v0.1 baseline

1. Cloud Lee T License Center (production transactional DB, MFA, roles, secret key custody, tamper-evident logs, payment integration and authorization endpoints).
2. Windows hardware fingerprint collection and persistent installation IDs; issuance API is not wired to the Warehouse server.
3. Online activation endpoints, offline request/import GUI, paid update UI, actual upgrade migration gates, server license enforcement. Offline licenses cannot instantaneously revoke an old disconnected PC.
4. Real mDNS service advertisement and resolution, HTTPS trust and server certificate pinning, authenticated device enrollment and revocation.
5. Android/iOS Capacitor apps and camera-based product scanning.
6. Commercial Windows all-in-one installer and clean-machine acceptance testing.
7. Commercial backup encryption/restore drills and real-device end-to-end testing.

## v0.1 baseline test environment findings

- Node.js installed: 22.16.0; project requires `^22.17.0 || >=24`, so runtime compliance is **not met**.
- `npm ci --offline` failed because npm cache lacks `yocto-queue`; online `npm ci` did not finish in the available runtime. No dependence or test has been removed to work around that.
- Existing full suite cannot load 10 dependent test files (e.g. `pg`, `sharp`) because `node_modules` is incomplete. These must be rerun in a complete supported Node runtime.
- `node scripts/check-stage0.mjs` passes after ZIP filename repair.
- Commercial primitives pass their 13 tests; these are not proof that the installed product works on Windows or mobile phones.

## Release gates (all mandatory)

- `npm ci` under supported Node 24; `npm test`; `npm run lint`; `npm run check`; other preflight gates.
- PostgreSQL transactional integration tests, payment/redeem concurrency in real DB and duplicate customer isolation.
- Real Windows 11 install/restore test; Android and iOS LAN pairing, revocation, camera scan and OS permission tests.
- Backup/recovery, rollback, HTTPS certificate, router isolation and security abuse tests.
- Do not label the product sellable or fully accepted until every gate is passed and production key management is in place.

## Offline server activation development entry point

Use a protected server configuration, with an absolute `LEE_T_LICENSE_DIR` outside
the business data directory and the issuer's trusted public key in
`LEE_T_ISSUER_PUBLIC_KEY_PATH`. Set `LEE_T_ISSUER_KEY_ID` to the issuer key ID.
Keep this directory and the trust configuration writable only by the installing
administrator or service identity, as appropriate. The installer still needs
to provision and verify the Windows ACLs and to select the commercial entry
point.

1. On the Windows server, run `node scripts/lee-t-license.mjs request` to
   generate a request JSON with hashed hardware claims. The installation ID
   remains stable on repeated requests.
2. Obtain the signed license for that request from the issuer. The issuer's
   private key stays on the issuer side.
3. Run `node scripts/lee-t-license.mjs install <signed-license.json>`.
   Import verifies the signature, device and running version before replacing
   the local license.
4. Run `npm run start:commercial`. The server checks the license before
   opening the database or listening. The original internal Warehouse uses
   its existing `npm start` entry point.

Windows hardware collection and the service account's access to hardware IDs
still require target-machine verification. Online activation and production
issuer deployment remain separate milestones.

## PostgreSQL initial activation ledger

The issuer can now issue initial activation codes in a separate PostgreSQL
database and redeem them in transactions. The ledger stores code hashes,
expiry, the signed result, and issuance/redemption audit events. Concurrent
requests from different installations can issue only one license. A retry
with the original request and code can retrieve the same signed result until
the code expires, including after a lost response.

This module requires a separate trusted issuer service. Its operator
authentication, payment records, HTTPS endpoint, deployment, upgrade and
transfer workflows are still pending.

## Online initial activation development service

`node scripts/start-activation-service.mjs` reads a protected JSON file at
`LEE_T_ACTIVATION_SERVICE_CONFIG`. The file supplies `databaseUrl`,
`tlsKeyPath`, `tlsCertPath`, `issuerKeyPath` and `issuerKeyId`. The default
listener is `127.0.0.1:8443`; `bind` and `port` can be configured on the
issuer host. Use a separate PostgreSQL database from the warehouse. Only the
redemption route is exposed; payment confirmation and initial-code issuance
are performed by trusted issuer code.

On the customer server, configure `LEE_T_ACTIVATION_ORIGIN` as the trusted
HTTPS origin for the redemption service. Pass the activation code through
stdin to `node scripts/lee-t-license.mjs activate`. The client checks the
issuer signature and the local device before saving the response. Following
activation, startup validates the saved license locally.

The issuer service is a development entry point. Admin MFA, customer and
payment management, production deployment protections, update installation
and warehouse data migration remain open.

## Paid upgrades and server replacement approvals

A trusted operator can issue initial, upgrade or transfer codes with
`node scripts/issue-activation-code.mjs <approval.json>`. It reads the
issuer database connection from `LEE_T_ACTIVATION_SERVICE_CONFIG`. Start the
issuer service once to initialize its database before issuing codes. The approval
file contains `kind`, `customerId`, `version`, `expiresAt` and `paid`.
Follow-up approvals also require `priorLicenseId`, a hashed device
`request` from the intended server, `paymentReference` and `approvedBy`.
Keep these files on the issuer host and deliver the generated code to the
approved customer through a private channel.

An upgrade requires the current installation and at least two matching
hardware claims. A transfer requires a different server. Redemption must
match the approved request exactly, and a successful redemption supersedes
its predecessor in the issuer database in the same transaction. A failed
signing attempt rolls back the change. An expired, unused approval can be
reissued using the same receipt for the same target and version. Issuance,
replacement and redemption records remain available in the issuer database.

The operator CLI relies on issuer host access controls. Production login,
MFA, payment reconciliation and independent audit retention are pending.
An already activated offline predecessor remains locally usable while
disconnected. This module does not install updates or migrate warehouse data.

## Employee QR enrollment in the commercial warehouse

With `npm run start:commercial`, an administrator can open Team and issue
a QR code for a specific active employee. The QR contains the configured
HTTPS origin and a two-minute, single-use invitation. The employee opens
it with the intended browser and signs in. The server consumes the
invitation and binds the device inside the login transaction. A second
browser requires administrator unbinding and a fresh invitation.

The server stores a digest of the device credential and sends the credential
as an HTTPS-only, HttpOnly cookie. Employee API calls require both the
paired-device cookie and a valid session. Administrators keep their existing
multi-device login. Force sign-out ends the employee session while preserving
the pairing. Unbind removes the pairing, clears any pending invitation,
ends sessions and invalidates an active stocktake run. Issuance, binding and
administrator actions are recorded in the local pairing audit table.

Warehouse backups exclude local invitations, device credentials and pairing
audit. A restored employee account must pair again. The restore validator
accepts version 7 archives when the exact schema/checksum match differs only
by the local-device migration.

This implementation is for the browser. DNS-SD advertisement and discovery,
native mobile integration, and real customer LAN and device acceptance remain
open. A browser with a cleared cookie also requires an administrator to
unbind and issue a replacement invitation.

## License Center management service

The management service has a dedicated HTTPS listener. It serves the
customer, payment, issuance and recent audit screens from the issuer-side
database. It does not share an HTTP listener with public activation redemption.

1. Start the activation service to initialize the issuer database schema.
2. Configure a separate protected JSON file for management. Set
   `databaseUrl`, `origin`, `tlsKeyPath`, `tlsCertPath`, `clientCaPath`,
   and optionally `bind` (defaults to loopback). The server takes its
   listening port from the HTTPS origin.
3. Configure the `operators` array. Each entry requires `id`, `role`
   (`sales` or `issuer`), the client certificate's SHA-256 `fingerprint`
   in uppercase colon-separated notation, and an Argon2id `passwordHash`.
   Optionally set `customerId` to limit an operator to one existing customer.
   Provide each operator their own client certificate and password. The
   browser uses the certificate during the TLS handshake and prompts for the
   matching operator ID and password.
4. Start `node scripts/start-license-management.mjs` with
   `LEE_T_MANAGEMENT_CONFIG` pointing to that file. The management process
   has no license signing key. Keep the database and configuration protected
   on the issuer host.

Register a customer, confirm a unique receipt for the purchased version and
kind, then issue a code with the issuer role. The paid issuance transaction
locks the receipt, records the activation code hash and appends audit records.
Only the authorized response at issuance contains the original activation
code. An unused expired code can be replaced using the existing receipt.

The management service has local integration coverage using real TLS, client
certificates and PostgreSQL. Cloud deployment, operator certificate
provisioning and revocation operations, offline signing workflow,
independent audit retention and recovery drills remain open. Existing
issuer CLI functions remain available to trusted host operators.

## Offline signing and issuer recovery rehearsal

On the customer server, run `node scripts/lee-t-license.mjs request` and
send the resulting device request JSON to the issuer. The issuer first
registers and confirms the purchase through License Center, then generates
the activation code. On the protected issuer host, run
`node scripts/sign-offline-license.mjs device-request.json < activation-code.txt > new-license.json`.
The command uses `LEE_T_ACTIVATION_SERVICE_CONFIG` for the issuer database and
signing key. Keep the signing key on the issuer host. Send only the signed
license to the customer for import with
`node scripts/lee-t-license.mjs install new-license.json`.

Offline issuance uses the same transactional redemption path as HTTPS.
A repeat request for the same device can retrieve the same signed license
while the code is still valid. A different device, an expired code or a
superseded authorization cannot redeem it.

The recovery test takes a consistent logical snapshot of the issuer ledger
and restores it into a separate test schema. It verifies payments, audit,
supersession, pending device-bound transfer, signing and retry behavior.
Production backup automation, secure key recovery, off-host retention and
cloud recovery acceptance still require deployment and a production-style
restore drill.

## LAN discovery

The commercial server can advertise `_leet-warehouse._tcp.local` through
mDNS/DNS-SD. Set `LEE_T_MDNS=1` with a direct HTTPS LAN listener
(`APP_BIND=0.0.0.0` or `::`) and a configured `.local` HTTPS origin
whose certificate is trusted on the client. Discovery is opt-in so existing
reverse-proxy and plain loopback installations continue to use their
configured address. The server re-advertises when its interface addresses
change and withdraws the advertisement on graceful shutdown.

The diagnostic client can read a JSON file containing the paired
`serverId` and `origin` with
`node scripts/find-warehouse.mjs paired-server.json`. It only probes the
paired HTTPS origin when the DNS-SD identity, host and port match. It connects
to the advertised IP while keeping the paired hostname for TLS certificate
validation, so a stale OS DNS entry does not redirect the probe. It rejects
certificate failures, mismatched HTTPS identities and redirects.
Discovery is a convenience for an already paired client. It grants no
employee access. If discovery fails, append the server IP to the diagnostic
command to verify it directly using the same paired hostname and certificate
checks. The tool prints the paired HTTPS origin on success.

The automated discovery test exchanges real UDP multicast packets on
loopback and verifies HTTPS before and after an advertised IP change using a test certificate. An adapter fixture
provides the loopback address because this test environment does not
expose host adapter enumeration. Address-change handling has a separate
automated test. Windows and smartphone discovery on the actual LAN,
including DHCP address change and AP isolation, still require field testing.

### Collecting discovery evidence on the warehouse LAN

In the commercial administrator’s Team page, select **Download LAN diagnostic
configuration** to obtain `paired-server.json`. It contains only the server
ID and configured HTTPS origin. Copy it to the Windows client on the same LAN. Use the trusted HTTPS
certificate setup for the site. If Node needs the site's CA, set
`NODE_EXTRA_CA_CERTS` to the trusted CA PEM before starting the diagnostic.

1. Run `node scripts/find-warehouse.mjs --json paired-server.json` and save
   the output. Record the verified address as the baseline.
2. After an authorized DHCP/address-change test, wait for the server to
   refresh its advertisement. Run the same command again. Confirm
   `verified: true`, the same HTTPS origin and the new address.
3. With discovery unavailable, run
   `node scripts/find-warehouse.mjs --json paired-server.json <server-ip>`.
   Confirm that a successful manual check verifies the same origin and
   the supplied address. A failed check exits with status 1 and provides
   a reason without returning a verified address.
4. Record separately the results of Windows and phone discovery, trusted
   HTTPS, camera use and reconnect on the actual warehouse network. The
   diagnostic report proves only the connection check from the machine
   that ran it.

The optional JSON output contains UTC time, discovery method, status and
the verified HTTPS origin and address on success. It omits invitation
tokens and device credentials. Existing text output remains available.

### Mobile pairing client foundation

The browser and future mobile launcher share the QR invitation parser.
It accepts only the versioned pairing format and a canonical HTTPS origin,
validates IDs, token and expiry, and discards unknown fields. A launcher can
use the preflight helper to verify the HTTPS server identity before opening
the sign-in link. The preflight request sends neither the invitation nor
credentials, follows no redirects, and checks expiry again before returning.

iOS, release signing and device acceptance remain open. The shared
JavaScript module is covered by parsing, identity and browser pairing tests.

### Android warehouse workspace

LEE T Mobile scans the employee invitation and verifies the server over
trusted HTTPS before opening a dedicated in-app WebView. The workspace uses
the warehouse screens and permissions for employee sign-in, receiving,
dispatch and counts. With a fingerprint-bearing pairing code, it loads
packaged pages on a private WebView origin and sends business JSON, product
photos and count events through a native TLS transport that checks the same
fingerprint on each connection. The native cookie store keeps sessions out
of the WebView. Only the device cookie is saved across app restarts, in app
storage excluded from backup. Invitations and passwords are not persisted.
Legacy invitations retain the system-trusted HTTPS path.

From `mobile/`, run `npm ci` and `npm run android:prepare` to generate and sync
the Android project. The project requires Android SDK 36 and a Gradle
toolchain that can download its locked distribution and dependencies.
Build a debug package with `gradlew.bat assembleDebug` in `mobile/android/`
on Windows or `./gradlew assembleDebug` on a compatible Unix host.
The development application ID is `my.leet.warehouse`.

The launcher requires trusted HTTPS. Android preparation configures
system and user-installed certificate authorities for the warehouse CA
while disallowing cleartext. The hostname and server identity checks
remain in force. A browser and Android must both trust the site CA.

Bundle creation and Android project generation/sync passed. APK compilation
was attempted but blocked before compilation because the environment could
not fetch the Gradle distribution. Android camera, in-app sign-in, receiving, dispatch and counts still require
real-device verification. Release signing and iOS remain open.

### Windows offline installer payload preparation

A Windows build machine can stage the committed application, its production
dependencies, the native service host, portable Node.js 24 x64 and PostgreSQL
17 binaries in one directory using `scripts/windows/Stage-CommercialPayload.ps1`.
The build machine supplies the unpacked vendor distributions and retrieves
locked npm dependencies during staging. The staged customer runtime contains
Node and its production dependencies without requiring a customer npm install.
The staging script checks that the runtimes are present, checks their versions,
loads native dependencies and publishes the directory only after staging succeeds.

The service installation script has explicit options for a bundled Node
executable and pre-staged dependencies. Commercial service setup verifies an
installed license before creating its service or initializing the database.
It uses a separate service name and a fixed activation-enforcing entry point.

This is an installer build component. Automatic PostgreSQL service and database
provisioning, the customer activation wizard, signed setup executable and
clean-Windows install and rollback acceptance remain open. The build machine
steps are not customer installation steps.

### Bundled PostgreSQL provisioning

The Windows installer build now includes a provisioning component for a
dedicated PostgreSQL 17 cluster. It uses the bundled binaries, reserves a
separate Windows service, configures loopback-only access and SCRAM, and
creates the limited application database owner. It disables the temporary
superuser login after provisioning. The application connection is returned
to the installer for protected configuration and must not be logged.

The Windows native CI check exercises occupied-port refusal, service
registration and restart, migration, and application-role privileges.
The commercial service installer calls this component when provided with
the bundled PostgreSQL runtime and a dedicated cluster path. The database
service runs as NetworkService while the warehouse service runs as LocalService.
The installer copies the verified installation identity, license and public
key into a service-readable directory, and makes the protected service
configuration read-only for the warehouse service account.
The customer wizard, executable packaging and end-to-end rollback validation
remain open.

The installer-side entry `Install-CommercialPayload.ps1` consumes the
staged payload and verified offline license. It wires up the bundled Node
and PostgreSQL paths automatically and selects the LAN address when exactly
one suitable private IPv4 address is available. This entry is intended to
be called by setup packaging, and is not the customer-facing executable.
