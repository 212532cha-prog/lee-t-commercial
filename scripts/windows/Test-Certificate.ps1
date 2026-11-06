$ErrorActionPreference='Stop'
$directory=Join-Path ([IO.Path]::GetTempPath()) ('Warehouse TLS '+[guid]::NewGuid().ToString('N'))
$certificate=$null
try {
    $certificate=& (Join-Path $PSScriptRoot 'New-LanCertificate.ps1') -Address '192.168.10.25' -Directory $directory
    $env:TEST_PFX=$certificate.PfxPath
    $env:TEST_PASSPHRASE=$certificate.Passphrase
    $env:TEST_CA=$certificate.RootCertificate
    & node (Join-Path $PSScriptRoot '..\verify-generated-certificate.mjs')
    if($LASTEXITCODE -ne 0){throw 'Generated Windows certificate failed strict TLS verification.'}
} finally {
    if($certificate){foreach($thumb in @($certificate.RootThumbprint,$certificate.LeafThumbprint)){Remove-Item ('Cert:\LocalMachine\My\'+$thumb) -ErrorAction SilentlyContinue}}
    Remove-Item Env:TEST_PFX,Env:TEST_PASSPHRASE,Env:TEST_CA -ErrorAction SilentlyContinue
    Remove-Item $directory -Recurse -Force -ErrorAction SilentlyContinue
}
