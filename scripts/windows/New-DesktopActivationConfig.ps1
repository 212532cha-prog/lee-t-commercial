#Requires -RunAsAdministrator
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$PayloadDirectory,
 [Parameter(Mandatory=$true)][string]$LicenseDirectory,
 [Parameter(Mandatory=$true)][string]$IssuerPublicKey,
 [Parameter(Mandatory=$true)][string]$IssuerKeyId,
 [string]$ActivationEndpoint
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Protect-Directory.ps1')
$payload=(Resolve-Path -LiteralPath $PayloadDirectory).Path
if(-not [IO.Path]::IsPathRooted($LicenseDirectory) -or -not (Test-Path -LiteralPath $IssuerPublicKey -PathType Leaf) -or
   [string]::IsNullOrWhiteSpace($IssuerKeyId) -or $IssuerKeyId.Length -gt 160){throw 'Invalid activation setup settings.'}
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
if((Test-Path -LiteralPath $config) -or (Test-Path -LiteralPath $publicKey)){throw 'Activation setup already exists. Preserve it for the repair workflow.'}
foreach($path in @((Join-Path $payload 'runtime\node.exe'),(Join-Path $payload 'app\scripts\desktop-activation.mjs'),(Join-Path $desktop 'LeeT.Warehouse.exe'))){
 if(-not (Test-Path -LiteralPath $path -PathType Leaf)){throw 'The complete desktop payload is required.'}
}
# Setup owns this operation. The ordinary app can execute binaries, but cannot alter issuer trust/configuration.
foreach($path in @($desktop,(Join-Path $payload 'runtime'),(Join-Path $payload 'app'),$trust)){
 Protect-Directory $path 'RX' -AllowDesktopRead
}
Protect-Directory ([IO.Path]::GetFullPath($LicenseDirectory)) 'RX'
Copy-Item -LiteralPath $IssuerPublicKey -Destination $publicKey
$environment=@{
 LEE_T_LICENSE_DIR=[IO.Path]::GetFullPath($LicenseDirectory)
 LEE_T_ISSUER_PUBLIC_KEY_PATH=$publicKey
 LEE_T_ISSUER_KEY_ID=$IssuerKeyId
}
if($ActivationEndpoint){$environment.LEE_T_ACTIVATION_ENDPOINT=$ActivationEndpoint}
[IO.File]::WriteAllText($config,(@{Environment=$environment}|ConvertTo-Json -Depth 3),[Text.UTF8Encoding]::new($false))
$acl=[Security.AccessControl.FileSecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
$administrator=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$acl.SetOwner($administrator)
foreach($sid in @('S-1-5-32-544','S-1-5-18')){
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','Allow'))
}
Set-Acl -LiteralPath $config -AclObject $acl
Write-Output 'Protected LEE T desktop activation settings prepared. No warehouse database configuration was copied.'
