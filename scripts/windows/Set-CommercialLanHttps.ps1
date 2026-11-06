#Requires -RunAsAdministrator
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$ConfigPath,
 [Parameter(Mandatory=$true)][string]$Address,
 [Parameter(Mandatory=$true)][string]$HttpsHostname,
 [Parameter(Mandatory=$true)][string]$HttpsPfxPath
)
$ErrorActionPreference='Stop'
$configFile=(Resolve-Path -LiteralPath $ConfigPath).Path
$source=(Resolve-Path -LiteralPath $HttpsPfxPath).Path
$adapter=Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -eq $Address | Select-Object -First 1
if(-not $adapter -or (Get-NetConnectionProfile -InterfaceIndex $adapter.InterfaceIndex).NetworkCategory -ne 'Private'){
 throw 'Select the IPv4 address of this computer on its private warehouse network.'
}
$service='LeeTCommercialWarehouse'
$scm=Get-CimInstance Win32_Service -Filter "Name='$service'"
if(-not $scm -or $scm.State -ne 'Running' -or $scm.PathName -notmatch (' "'+[regex]::Escape($configFile)+'"$')){
 throw 'Select the protected configuration of the running commercial warehouse service.'
}
$data=Split-Path -LiteralPath $configFile
$lock=[IO.File]::Open((Join-Path $data '.lan-https.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::Write,[IO.FileShare]::None)
$stage=$null
$committed=$false
$changed=$false
$stopped=$false
try{
 $config=Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
 if($config.ServiceName -ne $service -or -not $config.Environment.TLS_PFX_PATH -or -not $config.Environment.APP_PORT){
  throw 'The warehouse service does not have a supported PFX configuration.'
 }
 $licenseDirectory=$config.Environment.LEE_T_LICENSE_DIR
 if(-not $licenseDirectory){throw 'The warehouse activation directory is missing.'}
 $serverId=(Get-Content -LiteralPath (Join-Path $licenseDirectory 'installation-id') -Raw).Trim()
 if($serverId -notmatch '^[a-fA-F0-9-]{36}$'){throw 'The warehouse installation ID is invalid.'}
 $oldOrigin=[Uri]$config.Environment.PUBLIC_ORIGIN
 $port=[int]$config.Environment.APP_PORT
 if($oldOrigin.Scheme -ne 'https' -or $oldOrigin.Port -ne $port){throw 'The warehouse HTTPS configuration has an unexpected port.'}

 $stage=Join-Path $data ('lan-https-'+[guid]::NewGuid().ToString('N'))
 New-Item -ItemType Directory -Path $stage | Out-Null
 & icacls.exe $stage '/inheritance:r' '/grant:r' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Could not secure the certificate directory.'}
 $pfx=Join-Path $stage 'server.pfx'
 Copy-Item -LiteralPath $source -Destination $pfx
 $node=$config.NodePath
 $verify=Join-Path $PSScriptRoot '..\verify-lan-https.mjs'
 $secure=Read-Host 'Warehouse HTTPS PFX password' -AsSecureString
 $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
 try{$passphrase=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
 [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($passphrase)) | & $node $verify $HttpsHostname $Address $pfx
 if($LASTEXITCODE -ne 0){throw 'Warehouse HTTPS certificate preflight failed.'}
 $origin='https://'+$HttpsHostname.ToLowerInvariant()+':'+$port
 $config.Environment.PSObject.Properties.Remove('LEE_T_PAIRING_CERT_PATH')
 $config.Environment.PUBLIC_ORIGIN=$origin
 $config.Environment.TLS_PFX_PATH=$pfx
 $config.Environment.TLS_PFX_PASSPHRASE=$passphrase
 $replacement=Join-Path $stage 'new.json'
 $original=Join-Path $stage 'previous.json'
 [IO.File]::WriteAllText($replacement,($config|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))

 $stopped=$true
 Stop-Service -Name $service
 [IO.File]::Replace($replacement,$configFile,$original)
 $changed=$true
 Start-Service -Name $service
 $verified=$false
 for($attempt=0;$attempt -lt 6;$attempt++){
  & $node $verify --probe $origin $serverId
  if($LASTEXITCODE -eq 0){$verified=$true;break}
  Start-Sleep -Seconds 2
 }
 if(-not $verified){throw 'The updated warehouse did not answer over trusted HTTPS.'}
 $committed=$true
 Remove-Item -LiteralPath $original -Force
 Write-Output ('Warehouse HTTPS is ready at '+$origin+'. Generate a fresh employee pairing QR.')
}catch{
 if($committed){throw}
 try{
  if($changed){
   if((Get-Service -Name $service).Status -ne 'Stopped'){Stop-Service -Name $service}
   [IO.File]::Replace($original,$configFile,$null)
   $changed=$false
  }
  if($stopped -and (Get-Service -Name $service).Status -ne 'Running'){Start-Service -Name $service}
 }catch{throw 'HTTPS update failed and could not automatically restore service. Preserve the configuration and certificate directories for recovery.'}
 throw
}finally{
 if($stage -and -not $committed -and -not $changed){Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue}
 $lock.Dispose()
}
