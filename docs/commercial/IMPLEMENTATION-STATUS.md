# Lee T Commercial Edition — implementation status (2026-11-06)

## Source baseline

- Source: `warehouse-inventory-0.8.5-candidate.zip` supplied by product owner.
- Existing TAT LEE Warehouse business code is retained; no existing tests deleted or weakened.
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
payment management, deployment protections, paid updates and transfers
remain open.
