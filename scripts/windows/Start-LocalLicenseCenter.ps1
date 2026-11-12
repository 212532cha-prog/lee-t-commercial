#Requires -RunAsAdministrator
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$NodePath,
 [switch]$OfflineOnly,
 [string]$Root=(Join-Path $env:ProgramData 'Lee T License Center')
)
$ErrorActionPreference='Stop'
$config=Join-Path ([IO.Path]::GetFullPath($Root)) 'management.private.json'
if(-not (Test-Path -LiteralPath $config -PathType Leaf)){throw 'Initialize the local License Center first.'}
$previous=$env:LEE_T_MANAGEMENT_CONFIG
$previousMode=$env:LEE_T_OFFLINE_ONLY
try{
 $env:LEE_T_MANAGEMENT_CONFIG=$config
 if($OfflineOnly){$env:LEE_T_OFFLINE_ONLY='1'}
 & $NodePath (Join-Path $PSScriptRoot '..\start-license-management.mjs')
 if($LASTEXITCODE -ne 0){throw 'The local License Center could not start.'}
}finally{
 $env:LEE_T_MANAGEMENT_CONFIG=$previous
 $env:LEE_T_OFFLINE_ONLY=$previousMode
}
