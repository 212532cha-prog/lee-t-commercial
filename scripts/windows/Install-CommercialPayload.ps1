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
 [string]$HttpsPfxPath,
 [switch]$ConfirmNetworkTrust
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
$confirmedProfile=$null
if(-not $Address){
 . (Join-Path $PSScriptRoot 'Select-WarehouseNetwork.ps1')
 $profiles=@(Get-NetConnectionProfile | Where-Object NetworkCategory -eq 'Private')
 if($profiles.Count -eq 0 -and $ConfirmNetworkTrust){
  $profiles=@(Get-NetConnectionProfile | Where-Object NetworkCategory -eq 'Public')
 }
 $adapters=@($profiles | ForEach-Object {
  Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue
 })
 if($profiles.Count -eq 0){throw 'Connect to a trusted warehouse network and set its Windows network profile to Private.'}
 $routes=@(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
  ForEach-Object {
   $metric=(Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $_.InterfaceIndex).InterfaceMetric
   [pscustomobject]@{InterfaceIndex=$_.InterfaceIndex;RouteMetric=$_.RouteMetric;InterfaceMetric=$metric}
  })
 $selected=Select-WarehouseNetwork -Candidates $adapters -DefaultRoutes $routes
 $Address=$selected.IPAddress
 $profile=$profiles | Where-Object InterfaceIndex -eq $selected.InterfaceIndex | Select-Object -First 1
 if($profile.NetworkCategory -eq 'Public'){
  $answer=Read-Host ("Allow warehouse devices on the trusted network '"+$profile.Name+"' to connect? Windows will mark this network Private. [y/N]")
  if($answer -notin @('y','yes')){throw 'Setup stopped before changing the network profile.'}
  Set-NetConnectionProfile -InputObject $profile -NetworkCategory Private
  $confirmedProfile=$profile
 }
}
try{
& $installer -Commercial -OfflineDependencies -AppRoot $app -BundledNodePath $node `
 -BundledPostgresDirectory $postgres -DatabaseClusterRoot (Join-Path $root 'postgresql') `
 -DataDir (Join-Path $root 'data') -Address $Address -HttpsHostname $HttpsHostname -HttpsPfxPath $HttpsPfxPath `
 -LicenseDir (Resolve-Path -LiteralPath $LicenseDirectory).Path `
 -IssuerPublicKeyPath (Resolve-Path -LiteralPath $IssuerPublicKey).Path -IssuerKeyId $IssuerKeyId
}catch{
 if($confirmedProfile -and -not (Get-Service -Name LeeTCommercialWarehouse -ErrorAction SilentlyContinue)){
  try{Set-NetConnectionProfile -InterfaceIndex $confirmedProfile.InterfaceIndex -NetworkCategory Public}
  catch{Write-Warning 'The network profile could not be restored automatically.'}
 }
 throw
}
