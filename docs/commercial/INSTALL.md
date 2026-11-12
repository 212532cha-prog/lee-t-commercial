# LEE T Warehouse 0.8.5

Run `LEE-T-Warehouse-Setup.exe`. Windows and Android use the LEE T Warehouse name and the original LEE T logo; the separate issuer application is LEE T License Center.

Activation remains offline only. Export a device request from the warehouse installer, sign it through the matching License Center for version `0.8.5`, then import the signed license on the same warehouse computer. Keep the existing License Center keys and customer records.

The bundled issuer is `leet-local-45612fdc-3dfd-4478-a0f3-146214e06db2`. No private issuer key is bundled. Application IDs, service names, installation directories, data directories and authorization checks remain compatible.

The Windows package requires a valid publisher Authenticode signature before a signed commercial release. A name, logo, or version label alone does not establish a trusted publisher or remove SmartScreen warnings. Android debug artifacts are for acceptance testing only; a commercial APK must use the retained production signing key and pass the release acceptance gate. Do not uninstall an existing production app to work around a signing mismatch.

Windows Settings lists LEE T Warehouse and LEE T License Center separately. Existing data-retention and explicit deletion choices are unchanged.
