#Requires -RunAsAdministrator
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$PayloadDirectory,
 [Parameter(Mandatory=$true)][string]$LicenseDirectory,
 [Parameter(Mandatory=$true)][string]$IssuerPublicKey,
 [Parameter(Mandatory=$true)][string]$IssuerKeyId,
 [string]$ActivationEndpoint,
 [switch]$Resume
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
$desktop=Join-Path $payload 'desktop'
$config=Join-Path $desktop 'activation.private.json'
$trust=Join-Path $payload 'publisher'
$publicKey=Join-Path $trust 'issuer-public.pem'
if(Test-Path -LiteralPath (Join-Path $payload 'app\activation')){throw 'Activation setup already exists. Preserve it for the repair workflow.'}
$environment=@{
 LEE_T_LICENSE_DIR=$licensePath
 LEE_T_ISSUER_PUBLIC_KEY_PATH=$publicKey
 LEE_T_ISSUER_KEY_ID=$IssuerKeyId
}
if($ActivationEndpoint){$environment.LEE_T_ACTIVATION_ENDPOINT=$ActivationEndpoint}
if($Resume -and (Test-Path -LiteralPath $config -PathType Leaf)){
 $trustedWriters=@('S-1-5-32-544','S-1-5-18')
 $writes=[Security.AccessControl.FileSystemRights]'Write, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
 if(-not (Test-Path -LiteralPath $licensePath -PathType Container)){throw 'The original activation directory is missing.'}
 $activationFiles=@(Get-ChildItem -LiteralPath $licensePath -Force)
 foreach($item in @((Get-Item -LiteralPath $config,$desktop,$trust,$publicKey,$licensePath))+$activationFiles){
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Activation setup cannot use linked files or directories.'}
  $acl=Get-Acl -LiteralPath $item.FullName
  if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trustedWriters){throw 'Existing activation setup must remain protected.'}
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
   if($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $writes) -ne 0 -and $rule.IdentityReference.Value -notin $trustedWriters){
    throw 'Existing activation setup must remain protected.'
   }
  }
 }
 if(@($activationFiles | Where-Object {$_.PSIsContainer -or $_.Name -cnotin @('installation-id','license.json')}).Count){
  throw 'Existing activation data requires repair.'
 }
 $saved=(Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json).Environment
 if(@($saved.PSObject.Properties).Count -ne $environment.Count){throw 'Activation setup settings have changed.'}
 foreach($name in $environment.Keys){
  if($saved.$name -cne $environment[$name]){throw 'Activation setup settings have changed.'}
 }
 if((Get-FileHash -LiteralPath $publicKey).Hash -ne (Get-FileHash -LiteralPath $IssuerPublicKey).Hash){
  throw 'The issuer public key does not match the original activation setup.'
 }
 Write-Output 'Existing protected LEE T activation setup preserved.'
 return
}
if((Test-Path -LiteralPath $licensePath) -and @(Get-ChildItem -LiteralPath $licensePath -Force).Count){throw 'Existing activation data was found. Preserve it for repair or migration.'}
if((Test-Path -LiteralPath $config) -or (Test-Path -LiteralPath $publicKey)){throw 'Activation setup already exists. Preserve it for the repair workflow.'}
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
$programRoots=@($desktop,(Join-Path $payload 'runtime'),(Join-Path $payload 'app'),$trust)
New-Item -ItemType Directory -Path $trust -Force | Out-Null
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
Protect-Directory $licensePath 'RX'
$licenseSecurity=Get-Acl -LiteralPath $licensePath
$licenseSecurity.SetOwner($administrator)
Set-Acl -LiteralPath $licensePath -AclObject $licenseSecurity
Copy-Item -LiteralPath $IssuerPublicKey -Destination $publicKey
Set-ActivationFileAccess $publicKey
[IO.File]::WriteAllText($config,(@{Environment=$environment}|ConvertTo-Json -Depth 3),[Text.UTF8Encoding]::new($false))
Set-ActivationFileAccess $config -Private
Write-Output 'Protected LEE T desktop activation settings prepared. No warehouse database configuration was copied.'
