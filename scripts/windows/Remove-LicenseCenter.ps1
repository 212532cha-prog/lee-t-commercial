#Requires -RunAsAdministrator
param([Parameter(Mandatory=$true)][string]$InstallDirectory,[switch]$DeleteIssuerData)
$ErrorActionPreference='Stop'
$install=[IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
$root=Join-Path $env:ProgramData 'Lee T License Center'
$marker=Join-Path $root 'installation.json'
if(-not (Test-Path -LiteralPath $marker)){throw 'Issuer installation ownership record is missing. Nothing was deleted.'}
$owned=Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
if($owned.schema -ne 1 -or $owned.installDirectory -ne $install -or $owned.dataDirectory -ne $root){throw 'Issuer installation ownership mismatch. Nothing was deleted.'}
for($parent=[IO.DirectoryInfo]::new($root);$null -ne $parent;$parent=$parent.Parent){
 if($parent.Exists -and ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Linked issuer directories cannot be removed.'}
}
& "$PSScriptRoot\Stop-LicenseCenter.ps1" -InstallDirectory $install
foreach($name in @('LeeTLicenseCenter','LeeTLicensePostgreSQL17')){
 if(Get-Service $name -ErrorAction SilentlyContinue){
  & sc.exe delete $name | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Could not unregister an issuer service. Issuer data was retained.'}
 }
}
if($DeleteIssuerData){
 if(@(Get-ChildItem -LiteralPath $root -Force -Recurse | Where-Object {($_.Attributes -band [IO.FileAttributes]::ReparsePoint)}).Count){
  throw 'Issuer data contains linked entries. Data was retained for review.'
 }
 $caFile=Join-Path $root 'management-ca.cer'
 $operatorFile=Join-Path $root 'operator.cer'
 if(Test-Path -LiteralPath $caFile){
  $ca=[Security.Cryptography.X509Certificates.X509Certificate2]::new($caFile)
  try{
   Get-ChildItem Cert:\CurrentUser\My | Where-Object {$_.Thumbprint -eq $ca.Thumbprint -or $_.Issuer -eq $ca.Subject} | ForEach-Object {
    if($_.HasPrivateKey){Remove-Item -LiteralPath $_.PSPath -DeleteKey -Force}else{Remove-Item -LiteralPath $_.PSPath -Force}
   }
   $trusted='Cert:\LocalMachine\Root\'+$ca.Thumbprint
   if(Test-Path -LiteralPath $trusted){Remove-Item -LiteralPath $trusted}
  }finally{$ca.Dispose()}
 }
 if(Test-Path -LiteralPath $operatorFile){
  $operator=[Security.Cryptography.X509Certificates.X509Certificate2]::new($operatorFile)
  try{
   $certificate='Cert:\CurrentUser\My\'+$operator.Thumbprint
   if(Test-Path -LiteralPath $certificate){
    if((Get-Item -LiteralPath $certificate).HasPrivateKey){Remove-Item -LiteralPath $certificate -DeleteKey -Force}else{Remove-Item -LiteralPath $certificate -Force}
   }
  }finally{$operator.Dispose()}
 }
 Remove-Item -LiteralPath $root -Recurse -Force
}
