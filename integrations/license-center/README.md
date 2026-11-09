# LEE T activation Edge adapter

## Local offline signing

For first-time Windows setup, use an elevated PowerShell from the publisher
source directory with its locked Node dependencies installed. Point
`-NodePath` at a trusted Node executable and `-PostgresDirectory` at a
trusted PostgreSQL 17 distribution. The scripts may reuse those binaries
from a warehouse install. The issuer has a separate service, database,
data directory and signing key.

```powershell
.\scripts\windows\Initialize-LocalLicenseCenter.ps1 -NodePath <node.exe> -PostgresDirectory <PostgreSQL-directory>
.\scripts\windows\Start-LocalLicenseCenter.ps1 -NodePath <node.exe>
```

Open `https://127.0.0.1:8444` in a browser under the Windows account
that initialized the issuer. Choose the License Center client certificate,
then sign in as `issuer` with the password set during initialization.
Keep the console open while using the backend. The protected data directory
contains the publisher public key and its ID for client trust configuration.

The local operator service (`node scripts/start-license-management.mjs`) uses its
own local PostgreSQL issuer ledger, client certificate, and operator password.
To enable **Sign offline license**, configure both `issuerKeyId` and
`issuerKeyPath` in the protected management config. The private Ed25519 PEM
stays on the publisher PC. The signing-enabled listener and HTTPS origin must
both use loopback.

Select a customer and a confirmed payment, upload the customer's device
request JSON, and download `LeeT-signed-license.json`. Upgrades and transfers
also require the prior license ID. A retry with the same payment and device
request downloads the existing license. The customer imports the signed
JSON using an installer that trusts the matching public key.

This adapter exposes only `POST /v1/activation/redeem`. It reuses the existing PostgreSQL activation ledger and Ed25519 signatures. It has no customer, payment, signing-code creation, operator, or warehouse-data API. Existing mutual-TLS/password management remains unchanged.

## Build and test

Run `npm ci --ignore-scripts`, then `node scripts/build-license-edge.mjs /absolute/new/output`. The exact compiler and all dependencies come from the committed npm lock. The output contains a standalone `lee-t-activation.mjs`, SHA-256/source/dependency manifest and the complete notices for its 14 runtime packages (including license sections embedded in upstream READMEs). Deno uses the existing npm-installed modules for source checks; the deployed bundle does not require npm resolution at startup. The optional native pg addon is not deployed; the adapter uses the JavaScript driver.

The Edge workflow pins Deno 2.9.6, builds this standalone file, starts it as a separate real Deno HTTP process, and talks to a dedicated PostgreSQL 17 database over verified TLS. It rejects an untrusted certificate, verifies concurrent redemption and offline signatures, exercises paid upgrades and device refusal, and checks private-schema/default-deny RLS behavior with a non-owner role. It separately starts the same bundle without signing configuration and requires an unavailable response. No mock database, TLS bypass, skipped case or alternative runtime is used for this gate. Node 22/24 also run the complete existing regression and the Fetch-specific tests.

## Server configuration

- `LEE_T_ISSUER_PRIVATE_KEY`: Ed25519 PKCS#8 private PEM in protected server secret storage; never committed or bundled.
- `LEE_T_ISSUER_KEY_ID`: the trusted publisher key identifier.
- `LEE_T_ISSUER_DATABASE_URL`: dedicated issuer PostgreSQL URL, or the platform-provided `SUPABASE_DB_URL`.
- `LEE_T_ISSUER_DB_CA`: optional trusted database CA PEM. Certificate and hostname validation stay enabled.

The connection string cannot disable TLS or change the private `lee_t_license` search path. The adapter does not create tables or grant permissions on a public request. Before real signing is enabled, provision the ledger in that private schema, restrict a dedicated database role, inspect RLS/grants and advisors, and complete key recovery/rotation and actual hosted redemption acceptance. Do not use a customer's warehouse database or expose issuer tables to Data API roles.


The public endpoint uses the one-time activation code as its credential and does not use a warehouse session JWT. A hosted function therefore performs its own code authorization. This does not turn off operator MFA: management is not exposed by this adapter. Body bytes are bounded at 4,096; unsupported routes/methods and malformed content are rejected. Errors and diagnostics never contain a code, hardware request, database URL or signing material. There is no demo-key fallback.

Customer configuration can use the full protected `LEE_T_ACTIVATION_ENDPOINT` URL, allowing a hosted function path. HTTPS is mandatory, redirects are refused, and credentials, query strings or fragments are rejected. If an origin is supplied too, it must match. The older `LEE_T_ACTIVATION_ORIGIN` plus fixed path remains supported. These are publisher/install configuration values, not fields customers enter.

## Current hosted candidate

Project `kegjzqrhebzahqyomrbw`, function `lee-t-activation`, Singapore Free test environment:

`https://kegjzqrhebzahqyomrbw.supabase.co/functions/v1/lee-t-activation/v1/activation/redeem`

The standalone candidate loaded successfully over HTTPS: GET returned 405, a JSON POST returned the expected 503 `ACTIVATION_UNAVAILABLE` without signing configuration, and `/api/issue` returned 404. No signing key or issuer business tables have been provisioned by this stage. This is a fail-closed deployment check, not a successful production activation or a release-ready service. Customer activation UI, protected key provisioning, hosted signing/restore tests and operator MFA acceptance remain subsequent gates.
