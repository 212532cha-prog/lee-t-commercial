#Requires -RunAsAdministrator
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$PayloadDirectory,
 [Parameter(Mandatory=$true)][string]$LicenseDirectory,
 [Parameter(Mandatory=$true)][string]$IssuerPublicKey,
 [Parameter(Mandatory=$true)][string]$IssuerKeyId,
 [string]$ActivationEndpoint,
 [string]$ActivationCa,
 [switch]$Resume,
 [switch]$InstallerCache
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Protect-Directory.ps1')
$payload=(Resolve-Path -LiteralPath $PayloadDirectory).Path
if(-not [IO.Path]::IsPathRooted($LicenseDirectory) -or -not (Test-Path -LiteralPath $IssuerPublicKey -PathType Leaf) -or
   [string]::IsNullOrWhiteSpace($IssuerKeyId) -or $IssuerKeyId.Length -gt 160){throw 'Invalid activation setup settings.'}
$licensePath=[IO.Path]::GetFullPath($LicenseDirectory)
$licensePrefix=$licensePath.TrimEnd('\')+'\'
$payloadPrefix=$payload.TrimEnd('\')+'\'
if($licensePath -eq [IO.Path]::GetPathRoot($licensePath) -or $licensePrefix.StartsWith($payloadPrefix,[StringComparison]::OrdinalIgnoreCase) -or
   $payloadPrefix.StartsWith($licensePrefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Use a dedicated activation directory outside the program directory.'}
foreach($directory in @($licensePath,$payload)){
 for($parent=[IO.DirectoryInfo]::new($directory);$null -ne $parent;$parent=$parent.Parent){
  if($parent.Exists -and ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Activation setup cannot use a linked directory.'}
 }
}
if($ActivationEndpoint){
 $endpoint=$null
 if(-not [uri]::TryCreate($ActivationEndpoint,[UriKind]::Absolute,[ref]$endpoint) -or $endpoint.Scheme -ne 'https' -or
    $endpoint.UserInfo -or $ActivationEndpoint.Contains('?') -or $ActivationEndpoint.Contains('#') -or
    $ActivationEndpoint -ne $ActivationEndpoint.Trim() -or $ActivationEndpoint.Length -gt 2048){throw 'Activation requires the publisher HTTPS endpoint.'}
}
if($ActivationCa){
 if(-not $ActivationEndpoint -or -not (Test-Path -LiteralPath $ActivationCa -PathType Leaf)){throw 'A test CA requires the publisher HTTPS endpoint and a certificate file.'}
 $caText=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $ActivationCa).Path)
 if($caText.Length -gt 16384 -or $caText -cnotmatch '\A-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END CERTIFICATE-----\r?\n?\z'){throw 'Use one PEM activation CA certificate.'}
 $certificate=[Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String($Matches[1]))
 try{
  $constraints=$certificate.Extensions | Where-Object {$_ -is [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]}
  if(-not $constraints -or -not $constraints.CertificateAuthority){throw 'The activation certificate must be a CA.'}
 }finally{$certificate.Dispose()}
}
$desktop=Join-Path $payload 'desktop'
$config=Join-Path $desktop 'activation.private.json'
$trust=Join-Path $payload 'publisher'
$savedConfig=$config
if($InstallerCache){
 $trust=$licensePath
 $savedConfig=Join-Path $trust 'setup.private.json'
}
$publicKey=Join-Path $trust 'issuer-public.pem'
$caFile=Join-Path $trust 'activation-ca.pem'
if(Test-Path -LiteralPath (Join-Path $payload 'app\activation')){throw 'Activation setup already exists. Preserve it for the repair workflow.'}
$environment=@{
 LEE_T_LICENSE_DIR=$licensePath
 LEE_T_ISSUER_PUBLIC_KEY_PATH=$publicKey
 LEE_T_ISSUER_KEY_ID=$IssuerKeyId
}
if($ActivationEndpoint){$environment.LEE_T_ACTIVATION_ENDPOINT=$ActivationEndpoint}
if($ActivationCa){$environment.LEE_T_ACTIVATION_CA_PATH=$caFile}
$resuming=($Resume -or $InstallerCache) -and (Test-Path -LiteralPath $savedConfig -PathType Leaf)
if($resuming){
 $trustedWriters=@('S-1-5-32-544','S-1-5-18')
 $writes=[Security.AccessControl.FileSystemRights]'Write, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
 if(-not (Test-Path -LiteralPath $licensePath -PathType Container)){throw 'The original activation directory is missing.'}
 $activationFiles=@(Get-ChildItem -LiteralPath $licensePath -Force)
 $protectedPaths=@($savedConfig,$trust,$publicKey,$licensePath)
 if($ActivationCa){$protectedPaths+=$caFile}
 if(-not $InstallerCache){$protectedPaths+=$desktop}
 foreach($item in @((Get-Item -LiteralPath $protectedPaths))+$activationFiles){
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Activation setup cannot use linked files or directories.'}
  $acl=Get-Acl -LiteralPath $item.FullName
  if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trustedWriters){throw 'Existing activation setup must remain protected.'}
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
   if($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $writes) -ne 0 -and $rule.IdentityReference.Value -notin $trustedWriters){
    throw 'Existing activation setup must remain protected.'
   }
  }
 }
 $allowedFiles=@('installation-id','license.json')
 if($InstallerCache){$allowedFiles+=@('issuer-public.pem','setup.private.json')}
 if($InstallerCache -and $ActivationCa){$allowedFiles+='activation-ca.pem'}
 if(@($activationFiles | Where-Object {$_.PSIsContainer -or $_.Name -cnotin $allowedFiles}).Count){
  throw 'Existing activation data requires repair.'
 }
 $saved=(Get-Content -LiteralPath $savedConfig -Raw -Encoding UTF8 | ConvertFrom-Json).Environment
 if(@($saved.PSObject.Properties).Count -ne $environment.Count){throw 'Activation setup settings have changed.'}
 foreach($name in $environment.Keys){
  if($saved.$name -cne $environment[$name]){throw 'Activation setup settings have changed.'}
 }
 if((Get-FileHash -LiteralPath $publicKey).Hash -ne (Get-FileHash -LiteralPath $IssuerPublicKey).Hash){
  throw 'The issuer public key does not match the original activation setup.'
 }
 if($ActivationCa -and [IO.File]::ReadAllText($caFile) -cne $caText){
  throw 'The activation CA does not match the original activation setup.'
 }
 Write-Output 'Existing protected LEE T activation setup preserved.'
 if(-not $InstallerCache){return}
}
if(-not $resuming -and (Test-Path -LiteralPath $licensePath) -and @(Get-ChildItem -LiteralPath $licensePath -Force).Count){throw 'Existing activation data was found. Preserve it for repair or migration.'}
if((Test-Path -LiteralPath $config) -or (-not $resuming -and ((Test-Path -LiteralPath $publicKey) -or (Test-Path -LiteralPath $caFile)))){throw 'Activation setup already exists. Preserve it for the repair workflow.'}
foreach($path in @((Join-Path $payload 'runtime\node.exe'),(Join-Path $payload 'app\scripts\desktop-activation.mjs'),(Join-Path $desktop 'LeeT.Warehouse.exe'))){
 if(-not (Test-Path -LiteralPath $path -PathType Leaf)){throw 'The complete desktop payload is required.'}
}
# Protect copied files as well as their containers: a file may retain explicit grants from its source.
$administrator=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
function Set-ActivationFileAccess([string]$Path,[switch]$Private){
 $security=[Security.AccessControl.FileSecurity]::new()
 $security.SetAccessRuleProtection($true,$false)
 $security.SetOwner($administrator)
 foreach($sid in @('S-1-5-32-544','S-1-5-18')){
  $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','Allow'))
 }
 if(-not $Private){
  foreach($sid in @('S-1-5-19','S-1-5-32-545')){
   $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'ReadAndExecute','Allow'))
  }
 }
 Set-Acl -LiteralPath $Path -AclObject $security
}
$programRoots=@($desktop,(Join-Path $payload 'runtime'),(Join-Path $payload 'app'))
if(-not $InstallerCache){
 New-Item -ItemType Directory -Path $trust -Force | Out-Null
 $programRoots+=$trust
}
$programItems=@($programRoots | ForEach-Object {Get-Item -LiteralPath $_;Get-ChildItem -LiteralPath $_ -Recurse -Force})
if(@($programItems | Where-Object {($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0}).Count){throw 'Activation setup cannot use linked program files or directories.'}
foreach($item in $programItems){
 if($item.PSIsContainer){
  Protect-Directory $item.FullName 'RX' -AllowDesktopRead
  $security=Get-Acl -LiteralPath $item.FullName
  $security.SetOwner($administrator)
  Set-Acl -LiteralPath $item.FullName -AclObject $security
 }else{Set-ActivationFileAccess $item.FullName}
}
$settings=@{Environment=$environment}|ConvertTo-Json -Depth 3
$utf8=[Text.UTF8Encoding]::new($false)
if(-not $resuming){
 Protect-Directory $licensePath 'RX'
 $licenseSecurity=Get-Acl -LiteralPath $licensePath
 $licenseSecurity.SetOwner($administrator)
 Set-Acl -LiteralPath $licensePath -AclObject $licenseSecurity
 Copy-Item -LiteralPath $IssuerPublicKey -Destination $publicKey
 Set-ActivationFileAccess $publicKey
 if($ActivationCa){
  [IO.File]::WriteAllText($caFile,$caText,$utf8)
  Set-ActivationFileAccess $caFile
 }
 if($InstallerCache){
  [IO.File]::WriteAllText($savedConfig,$settings,$utf8)
  Set-ActivationFileAccess $savedConfig -Private
 }
}
[IO.File]::WriteAllText($config,$settings,$utf8)
Set-ActivationFileAccess $config -Private
Write-Output 'Protected LEE T desktop activation settings prepared. No warehouse database configuration was copied.'
