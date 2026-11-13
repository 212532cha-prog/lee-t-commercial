; Signing is explicit and fail-closed. The operator supplies the compiler's
; leetpublisher command; public CI never has a production signing key.
#ifdef PublisherSigning
SignTool=leetpublisher
SignedUninstaller=yes
SignToolRetryCount=0
SignToolRunMinimized=yes
SignedUninstallerDir={#PublisherUninstallerDir}
#endif
