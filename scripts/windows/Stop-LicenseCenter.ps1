#Requires -RunAsAdministrator
param([Parameter(Mandatory=$true)][string]$InstallDirectory)
$ErrorActionPreference='Stop'
$install=[IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
$root=Join-Path $env:ProgramData 'Lee T License Center'
$backend=Get-CimInstance Win32_Service -Filter "Name='LeeTLicenseCenter'"
$database=Get-CimInstance Win32_Service -Filter "Name='LeeTLicensePostgreSQL17'"
if($backend -and $backend.PathName -ne ('"'+(Join-Path $install 'LeeTLicenseCenterService.exe')+'" "'+$root+'"')){
 throw 'A different installation owns the signing service.'
}
if($database -and $database.PathName -notmatch ('(?i)-D\s+"'+[regex]::Escape((Join-Path $root 'postgresql\cluster'))+'"')){
 throw 'A different installation owns the issuer database service.'
}
if($backend){Stop-Service 'LeeTLicenseCenter'}
if($database){Stop-Service 'LeeTLicensePostgreSQL17'}
