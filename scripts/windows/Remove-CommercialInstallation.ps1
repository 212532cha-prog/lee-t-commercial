#Requires -RunAsAdministrator
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$PayloadDirectory,
 [switch]$CheckOnly,
 [switch]$RemoveData,
 [string]$WarehouseServiceName='LeeTCommercialWarehouse',
 [string]$DatabaseServiceName='LeeTPostgreSQL17'
)
$ErrorActionPreference='Stop'
$payload=(Resolve-Path -LiteralPath $PayloadDirectory).Path.TrimEnd('\')
$record=Get-Content -LiteralPath (Join-Path $payload 'commercial-install.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$data=[IO.Path]::GetFullPath($record.DataRoot).TrimEnd('\')
$prefix=$payload+'\'
$dataPrefix=$data+'\'
if($record.Schema -ne 1 -or $record.PayloadDirectory -cne $payload -or
 $data -eq [IO.Path]::GetPathRoot($data).TrimEnd('\') -or
 $prefix.StartsWith($dataPrefix,[StringComparison]::OrdinalIgnoreCase) -or
 $dataPrefix.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or
 $data -eq $env:ProgramData -or $data -eq $env:ProgramFiles -or $data -eq $env:USERPROFILE){
 throw 'The saved installation paths require repair before removal.'
}
foreach($path in @($payload,$data)){
 for($parent=[IO.DirectoryInfo]::new($path);$null -ne $parent;$parent=$parent.Parent){
  if($parent.Exists -and ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Removal cannot use linked directories.'}
 }
}
$owned=@($WarehouseServiceName,$DatabaseServiceName)
$services=@(Get-CimInstance Win32_Service)
foreach($service in $services){
 $usesPayload=$service.PathName -match ('(?i)(?:^|[" ])'+[regex]::Escape($prefix))
 if($usesPayload -and $service.Name -notin $owned){
  throw ('Another service uses these program files. Move its runtime before uninstalling. Service '+$service.Name)
 }
 if($service.Name -in $owned -and (-not $usesPayload -or $service.PathName -notmatch [regex]::Escape($dataPrefix))){
  throw ('Service belongs to another installation. Service '+$service.Name)
 }
}
if($RemoveData -and (Test-Path -LiteralPath $data)){
 if(@(Get-ChildItem -LiteralPath $data -Force -Recurse | Where-Object {($_.Attributes -band [IO.FileAttributes]::ReparsePoint)}).Count){
  throw 'Data contains linked entries. Review these entries before removing data.'
 }
}
if($CheckOnly){Write-Output 'Installation ownership and runtime dependencies verified.';return}
foreach($name in $owned){
 $service=Get-Service -Name $name -ErrorAction SilentlyContinue
 if($service){
  if($service.Status -ne 'Stopped'){Stop-Service -Name $name -ErrorAction Stop}
  $service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(60))
  & sc.exe delete $name | Out-Null
  if($LASTEXITCODE -ne 0){throw ('Could not remove service '+$name)}
  $service.Dispose()
 }
}
Get-CimInstance Win32_Process | Where-Object {
 $_.ExecutablePath -and $_.ExecutablePath.StartsWith((Join-Path $prefix 'desktop\'),[StringComparison]::OrdinalIgnoreCase)
} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop}
Get-NetFirewallRule -DisplayName 'LEE T Commercial Warehouse LAN*' -ErrorAction SilentlyContinue | ForEach-Object {
 $rule=$_
 $filter=$rule | Get-NetFirewallApplicationFilter
 if($filter.Program -eq (Join-Path $payload 'runtime\node.exe')){$rule | Remove-NetFirewallRule}
}
if($RemoveData -and (Test-Path -LiteralPath $data)){Remove-Item -LiteralPath $data -Recurse -Force -ErrorAction Stop}
Write-Output 'Warehouse services removed. Program removal can continue.'
