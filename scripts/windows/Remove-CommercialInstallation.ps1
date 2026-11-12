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
if($record.Schema -notin @(1,2) -or $record.PayloadDirectory -cne $payload -or
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
$cleanup=@()
if($RemoveData){
 $cleanup+=@($data)
 if($record.Schema -eq 2){
  $license=[IO.Path]::GetFullPath($record.LicenseDirectory).TrimEnd('\')
  if((Split-Path $license -Leaf) -ne 'Lee T Offline Activation' -or
      $record.InstallationId -notmatch '^[a-fA-F0-9-]{36}$'){
   throw 'The saved activation identity requires repair before full removal.'
  }
  if(Test-Path -LiteralPath $license){
   $identity=([IO.File]::ReadAllText((Join-Path $license 'installation-id'))).Trim()
   if($identity -cne $record.InstallationId){throw 'Activation belongs to another installation.'}
   $allowed=@('installation-id','issuer-public.pem','license.json','setup.private.json')
   if(@(Get-ChildItem -LiteralPath $license -Force | Where-Object {$_.PSIsContainer -or $_.Name -cnotin $allowed}).Count){
    throw 'Activation contains unrecognized entries. Review these entries before removal.'
   }
   $cleanup+=@($license)
  }
  $profiles=@($env:LOCALAPPDATA)
  $profiles+=@(Get-CimInstance Win32_UserProfile | Where-Object {-not $_.Special -and $_.LocalPath} | ForEach-Object {
   Join-Path $_.LocalPath 'AppData\Local'
  })
  foreach($profile in @($profiles | Select-Object -Unique)){
   $browser=Join-Path $profile 'LEE T\Warehouse Desktop'
   if(Test-Path -LiteralPath $browser){$cleanup+=@($browser)}
  }
 }
 foreach($directory in $cleanup){
  for($parent=[IO.DirectoryInfo]::new($directory);$null -ne $parent;$parent=$parent.Parent){
   if($parent.Exists -and ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Full removal cannot use linked directories.'}
  }
  if((Test-Path -LiteralPath $directory) -and
    @(Get-ChildItem -LiteralPath $directory -Force -Recurse | Where-Object {($_.Attributes -band [IO.FileAttributes]::ReparsePoint)}).Count){
   throw 'Full removal contains linked entries. Review these entries before removal.'
  }
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
} | ForEach-Object {
 & taskkill.exe /PID $_.ProcessId /T /F | Out-Null
 if($LASTEXITCODE -ne 0 -and (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue)){throw 'Could not close the warehouse desktop process tree.'}
}
Get-NetFirewallRule -DisplayName '* LAN HTTPS','* LAN discovery' -ErrorAction SilentlyContinue | ForEach-Object {
 $rule=$_
 $filter=$rule | Get-NetFirewallApplicationFilter
 if($filter.Program -eq (Join-Path $payload 'runtime\node.exe')){$rule | Remove-NetFirewallRule}
}
if($RemoveData){
 $tls=Join-Path $data 'data\tls'
 $caPath=Join-Path $tls 'warehouse-root-ca.cer'
 $leafPath=Join-Path $tls 'warehouse-server.cer'
 if((Test-Path -LiteralPath $caPath) -and (Test-Path -LiteralPath $leafPath)){
  $ca=[Security.Cryptography.X509Certificates.X509Certificate2]::new($caPath)
  $leaf=[Security.Cryptography.X509Certificates.X509Certificate2]::new($leafPath)
  try{
   if($ca.Subject -notlike 'CN=LEE T Warehouse CA *' -or $ca.Subject -cne $ca.Issuer -or $leaf.Issuer -cne $ca.Subject){
    throw 'The warehouse certificates require review before full removal.'
   }
   foreach($path in @(('Cert:\LocalMachine\Root\'+$ca.Thumbprint),('Cert:\LocalMachine\My\'+$ca.Thumbprint),('Cert:\LocalMachine\My\'+$leaf.Thumbprint))){
    if(Test-Path -LiteralPath $path){
     if((Get-Item -LiteralPath $path).HasPrivateKey){Remove-Item -LiteralPath $path -DeleteKey -Force -ErrorAction Stop}
     else{Remove-Item -LiteralPath $path -Force -ErrorAction Stop}
    }
   }
  }finally{$ca.Dispose();$leaf.Dispose()}
 }
}
foreach($directory in $cleanup){
 if(Test-Path -LiteralPath $directory){Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction Stop}
}
Write-Output 'Warehouse services removed. Program removal can continue.'
