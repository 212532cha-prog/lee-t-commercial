#Requires -RunAsAdministrator
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$PayloadDirectory,
 [Parameter(Mandatory=$true)][string]$LicenseDirectory,
 [Parameter(Mandatory=$true)][string]$IssuerPublicKey,
 [Parameter(Mandatory=$true)][string]$IssuerKeyId,
 [string]$DataRoot=(Join-Path $env:ProgramData 'Lee T Commercial'),
 [string]$Address,
 [string]$HttpsHostname,
 [string]$HttpsPfxPath
)
$ErrorActionPreference='Stop'
$payload=(Resolve-Path -LiteralPath $PayloadDirectory).Path
$app=Join-Path $payload 'app'
$runtime=Join-Path $payload 'runtime'
if(-not [IO.Path]::IsPathRooted($DataRoot)){throw 'Use an absolute commercial data root.'}
$root=[IO.Path]::GetFullPath($DataRoot)
$installer=Join-Path $app 'scripts\windows\Install-Warehouse.ps1'
$node=Join-Path $runtime 'node.exe'
$postgres=Join-Path $runtime 'postgresql'
foreach($file in @($installer,$node,(Join-Path $postgres 'bin\postgres.exe'),(Join-Path $app 'node_modules\pg\package.json'))){
 if(-not (Test-Path -LiteralPath $file -PathType Leaf)){throw 'The staged commercial payload is incomplete.'}
}
if(-not $Address){
 $adapters=@(Get-NetConnectionProfile | Where-Object NetworkCategory -eq 'Private' | ForEach-Object {
  Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue
 } | Where-Object { $_.AddressState -eq 'Preferred' -and $_.IPAddress -notlike '169.254.*' })
 if($adapters.Count -ne 1){throw 'Specify the IPv4 address of the trusted warehouse network.'}
 $Address=$adapters[0].IPAddress
}
& $installer -Commercial -OfflineDependencies -AppRoot $app -BundledNodePath $node `
 -BundledPostgresDirectory $postgres -DatabaseClusterRoot (Join-Path $root 'postgresql') `
 -DataDir (Join-Path $root 'data') -Address $Address -HttpsHostname $HttpsHostname -HttpsPfxPath $HttpsPfxPath `
 -LicenseDir (Resolve-Path -LiteralPath $LicenseDirectory).Path `
 -IssuerPublicKeyPath (Resolve-Path -LiteralPath $IssuerPublicKey).Path -IssuerKeyId $IssuerKeyId
