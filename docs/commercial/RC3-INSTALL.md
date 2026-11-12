# LEE T Commercial 0.8.5 RC3

This warehouse installer trusts issuer `leet-local-45612fdc-3dfd-4478-a0f3-146214e06db2`, matching the owner-provided public key. The private signing key remains on the License Center computer and is never included in the build.

Download and run `LEE-T-Commercial-0.8.5-RC3-Setup.exe`. Keep the current License Center installation and its signing keys. In the warehouse installer export a device request, sign that request through the matching License Center using a confirmed payment for version `0.8.5`, and import the resulting license on the same warehouse computer.

A failed activation attempt may have cached the previous issuer. RC3 updates only an unactivated, administrator-protected installer cache to its bundled public key and Key ID, preserving the installation ID. Existing licenses, unrelated setting changes, unsafe permissions, symlinks and unexpected cache entries continue to block trust changes. Signature, product, version, device and installation checks remain enforced. If a cached license already exists, use the protected repair/migration workflow; RC3 does not silently replace an activated installation's issuer.

This candidate is not Authenticode-signed. SmartScreen warnings may still appear. Existing warehouse data and services are protected by the original installation checks; do not remove customer data to resolve a signing-key mismatch. Windows Settings uninstall offers data retention or explicit permanent removal for this installer-owned warehouse. The separate License Center is retained.
