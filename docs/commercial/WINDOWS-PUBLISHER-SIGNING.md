# LEE T Windows publisher signing

The existing release artifacts remain unsigned until the owner supplies a valid code-signing identity. This implementation never substitutes the License Center issuer key, a management/server TLS certificate, or the Android release key.

## Production identity

Obtain a publicly trusted Windows code-signing certificate or a compatible signing service. Complete the provider's identity verification under the actual legal publisher name. Install its certificate and private-key provider in the Windows signing account's `My` certificate store. Hardware tokens and provider-backed non-exportable keys can be selected by thumbprint; these scripts do not export keys or accept a PFX password on the command line.

The expected subject must exactly match the certificate's legal subject. The product brand remains LEE T; Windows displays the certificate's verified publisher identity, which cannot be chosen arbitrarily in app metadata. Windows trust and SmartScreen reputation are separate; a valid signature does not guarantee that every reputation warning disappears immediately.

Use a controlled Windows release machine with the Windows SDK, Inno Setup 6 and the normal staged payload from `Stage-CommercialPayload.ps1` or `Stage-LicenseCenter.ps1`. Do not expose the production signing machine or credentials to pull-request jobs. All public CI tests use disposable test certificates and remove them afterward.

## Build a signed installer

Run Windows PowerShell with access to the signing key. Substitute the real certificate thumbprint and full subject:

```powershell
./scripts/windows/Build-PublisherSignedInstaller.ps1 `
  -Product LicenseCenter `
  -PayloadDirectory 'D:\release\license-center-payload' `
  -OutputDirectory 'D:\release\signed-license-center' `
  -CertificateThumbprint '<40-hex certificate thumbprint>' `
  -ExpectedSubject '<exact legal certificate subject>' `
  -TimestampUrl 'http://timestamp.digicert.com'
```

For Warehouse, use `-Product Warehouse` and additionally pass the existing `-OfflineIssuerPublicKey` and `-OfflineIssuerKeyId`. These offline license issuer values must remain unchanged. Use `-StoreLocation LocalMachine` only when the signing certificate and provider are installed in that store.

The builder copies the payload, signs only the LEE T desktop executable/assembly and service host, then invokes Inno's signing callback. That callback signs the installer, its temporary self-copies and the uninstaller. Vendor binaries are not re-signed. Inno's signed uninstaller cache is verified before publication. Output contains the installer, SHA256SUMS and a public signature manifest; no private key or password is included.

Signing uses SHA256 and RFC 3161/SHA256 timestamping. Nonzero SignTool exit codes (including warnings), invalid trust, wrong publisher, wrong certificate purpose, missing key, expired signing identity, missing timestamp, tampering and missing uninstaller signatures stop publication. Failed signing retains the original input file. Failed builds publish no signed output directory.

`Sign-WindowsPublisherFile.ps1 -VerifyOnly` verifies an existing PE file with the same expected thumbprint and subject; it does not require access to the private key. Verification uses Windows Authenticode and SignTool's default application authentication policy. Use a publicly issued certificate: trust installed manually on a build machine is not proof of public trust on customers' computers.

## Acceptance

The existing repository, desktop, activation, native service and installer lifecycle gates remain enabled. Additional native Windows tests create an isolated test certificate and require:

- production rejection of self-signed certificates and missing timestamps;
- test-mode rejection outside disposable CI;
- publisher mismatch and TLS-certificate rejection without modifying input;
- failed timestamp requests preserving the original input;
- real SignTool SHA256 signing, RFC 3161 timestamping and Windows verification;
- rejection of a tampered executable;
- the real Warehouse/License Center payload and installer passing signature checks;
- the signed License Center desktop, service and installed uninstaller retaining their signatures across signing, cold start, crash recovery, repair and reinstall, followed by full removal.

`-TestSigning` is a CI fixture mechanism, never a production identity. Test-signed installers are deleted in the test cleanup and are never uploaded as customer release artifacts.

Primary references: [Microsoft SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool), [Microsoft code-signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options), [Inno SignTool](https://jrsoftware.org/ishelp/topic_setup_signtool.htm), [Inno SignedUninstaller](https://jrsoftware.org/ishelp/topic_setup_signeduninstaller.htm).
