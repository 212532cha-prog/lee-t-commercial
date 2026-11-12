#Requires -RunAsAdministrator
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidatePattern('^LeeTLicensePostgreSQL17(?:-[a-f0-9]{8})?$')][string]$ServiceName,
 [Parameter(Mandatory=$true)][string]$PostgresDirectory,
 [Parameter(Mandatory=$true)][string]$ClusterDirectory
)
$ErrorActionPreference='Stop'
$control=Join-Path ([IO.Path]::GetFullPath($PostgresDirectory)) 'bin\pg_ctl.exe'
$cluster=[IO.Path]::GetFullPath($ClusterDirectory)
$record=Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
if(-not $record -or $record.StartName -notmatch 'NetworkService$' -or
 $record.PathName -notmatch ('(?i)^"'+[regex]::Escape($control)+'"\s+runservice\s') -or
 $record.PathName -notmatch ('(?i)-D\s+"'+[regex]::Escape($cluster)+'"')){
 throw 'Cannot verify ownership of the dedicated issuer database service.'
}
# SCM recovery is configured after provisioning. During the first bootstrap,
# provide bounded recovery too; never delete data, change ports or weaken auth.
$lastError=$null
for($attempt=1;$attempt -le 3;$attempt++){
 $service=Get-Service -Name $ServiceName
 try{
  if($service.Status -eq 'StopPending'){$service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))}
  if($service.Status -eq 'StartPending'){$service.WaitForStatus('Running',[TimeSpan]::FromSeconds(30))}
  $service.Refresh()
  if($service.Status -ne 'Running'){Start-Service -Name $ServiceName -ErrorAction Stop}
  $service.Refresh()
  $service.WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
  return
 }catch{
  $lastError=$_
  if($attempt -lt 3){
   Write-Warning ("PostgreSQL start attempt "+$attempt+" failed; retrying the owned issuer service.")
   Start-Sleep -Milliseconds (500*$attempt)
  }
 }finally{$service.Dispose()}
}
throw [InvalidOperationException]::new('Issuer PostgreSQL did not start after three bounded attempts. '+$lastError.Exception.Message,$lastError.Exception)
