# LEE T License Center — cloud readiness

Checked 2026-11-08. This records deployment preparation; it does not attest to a running authorization service.

## Completed baseline

- Warehouse and Windows management changes are merged through `ff5db2e58765acf6c410a271ce0ff477d3707eb8` (PRs 13 and 14).
- Tested application head `a290b1448580fe0db5b98b2b70d1a5f295944d38`: Node 22 and 24 with native PostgreSQL 17 each passed 295 tests, zero failures and skips. All 11 built management browser suites passed. Real Windows WebView2 tests passed for service recovery, sign-in, nine module entries, session reload and external navigation restrictions. Installer compilation and bundled-file verification passed.
- Evidence: Actions runs `42450711543` (core), `42450711571` (management), `42450711542` (Windows setup).
- The test setup executable SHA-256 is `9CD4E164AF9DAB9335B95326D6944FC1C7B0045E91C37C5FC2DAD7656781E943`. This is a test installer, not the signed commercial release.

## Isolated publisher project

| Item | Recorded state |
| --- | --- |
| Project | LEE T License Center |
| Supabase reference | `kegjzqrhebzahqyomrbw` |
| Organization | `sebyohzjbuutgakniqqw` |
| Region | Singapore, `ap-southeast-1` |
| Plan and creation quote | Free; quoted USD 0 monthly |
| Status at inspection | `ACTIVE_HEALTHY`, PostgreSQL 17.11 |
| Public application tables / Edge Functions | None |
| Signing keys / issued licenses / sales records | Not provisioned by this deployment preparation |

This project is reserved for publisher customers, payments, activation, approvals and authorization audit. Customer warehouse inventory, employee records, product images, reports and backups stay on each customer's own server. The pre-existing Supabase project was not changed. Cloudflare account access was checked read-only; existing DNS and Workers were not changed, and the paid Containers plan was not enabled. Its current Containers API response requires Workers Paid, so deploying the current Node server there is not an available free path.

The Free project quote covers this preparation, not a production uptime, retention or recovery guarantee. Capacity, inactivity behavior, backups and recovery must be accepted before commercial use. No paid plan change is authorized by this document.

## Next deployment gate

1. Keep the existing PostgreSQL authorization ledger and its concurrency/idempotency rules. The current Node HTTPS activation and mutual-TLS/password management servers cannot simply be uploaded as an Edge Function. Implement and test the hosting adapter before deployment; do not remove management factors or bypass authorization to fit the runtime.
2. Isolate issuer tables from public Data API roles, verify grants and RLS, and test anonymous, ordinary-user, cross-customer and revoked-session rejection. Never point the issuer at a customer's warehouse database.
3. Provision signing material in protected server storage with a recovery and rotation procedure. Private keys must never enter Git, browser bundles, the customer installer or test logs. The installer receives only publisher public trust configuration.
4. Exercise actual hosted redemption, concurrent single-use codes, interrupted responses, offline verification, unauthorized version/device refusal, and operator MFA before wiring the customer activation screen to that environment.
5. Integrate customer activation into the desktop installation/app flow. Keep the existing test-license import behavior until the replacement is verified. Do not ask customers to choose an issuer PEM, enter an IP/domain/DNS setting or install a phone CA as the normal released workflow.
6. Complete safe update/repair/rollback, signed distribution and physical Windows/Android/iPhone acceptance. No automatic data deletion, existing-installation reset or production release follows from these preparation checks.
