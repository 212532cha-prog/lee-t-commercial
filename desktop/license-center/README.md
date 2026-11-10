# Lee T License Center for Windows

This WPF desktop client uses the existing local License Center database and the Windows certificate of the issuer account. The signing key stays in the protected License Center directory.

## Launch

1. Use an already initialized local License Center on this PC. On a new PC, run the existing provisioning instructions in `integrations/license-center/README.md`.
2. In elevated PowerShell under the Windows user who provisioned the issuer, start `scripts/windows/Start-LocalLicenseCenter.ps1 -NodePath <node.exe> -OfflineOnly`. Keep the process running.
3. Open `LeeT-License-Center.exe` as the same Windows user and enter the issuer password.
4. Select or create the customer, select or record confirmed payment, choose the customer's device request JSON and save the signed license. Upgrades and transfers require the previous license ID.

The desktop client uses the default protected directory under ProgramData and the configured loopback port. It requires the provisioned issuer service and database on the same computer. English is the initial language, with Simplified Chinese and Malay available.

## Build

```powershell
dotnet publish desktop/license-center/LeeT.LicenseCenter.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o dist/license-center
```

Windows CI exercises the built executable against a separately provisioned test issuer and independently verifies its signed license. The EXE is a test build pending desktop visual and clean-machine acceptance.
