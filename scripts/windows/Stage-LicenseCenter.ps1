[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$DesktopDirectory,
 [Parameter(Mandatory=$true)][string]$PostgresDirectory,
 [Parameter(Mandatory=$true)][string]$OutputDirectory,
 [Parameter(Mandatory=$true)][string]$VcRedistPath
)
$ErrorActionPreference='Stop'
$signature=Get-AuthenticodeSignature -LiteralPath $VcRedistPath
if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|, )O=Microsoft Corporation(?:,|$)'){
 throw 'Microsoft-signed Visual C++ runtime installer required.'
}
$source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if(Test-Path -LiteralPath $OutputDirectory){throw 'Payload output already exists.'}
$node=(Get-Command node.exe).Source
$npm=(Get-Command npm.cmd).Source
$desktop=Join-Path $DesktopDirectory 'LeeT-License-Center.exe'
foreach($file in @($desktop,(Join-Path $PostgresDirectory 'bin\pg_ctl.exe'),(Join-Path $PostgresDirectory 'bin\pg_dump.exe'))){
 if(-not (Test-Path -LiteralPath $file -PathType Leaf)){throw 'Required desktop or PostgreSQL runtime missing.'}
}
$output=[IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path "$output\app","$output\runtime\postgresql" -Force | Out-Null
Copy-Item "$DesktopDirectory\*" $output -Recurse
Copy-Item $node "$output\runtime\node.exe"
Copy-Item $VcRedistPath "$output\runtime\vc_redist.x64.exe"
$vendorNotices=Join-Path $output 'licenses'
New-Item -ItemType Directory -Path $vendorNotices | Out-Null
$nodeLicense=Join-Path (Split-Path $node) 'LICENSE'
if(Test-Path -LiteralPath $nodeLicense){Copy-Item $nodeLicense "$vendorNotices\Node-LICENSE.txt"}
foreach($name in @('COPYRIGHT','license.txt')){
 if(Test-Path (Join-Path $PostgresDirectory $name)){Copy-Item (Join-Path $PostgresDirectory $name) (Join-Path $vendorNotices ('PostgreSQL-'+$name))}
}
foreach($name in @('bin','lib','share')){Copy-Item (Join-Path $PostgresDirectory $name) "$output\runtime\postgresql" -Recurse}
foreach($name in @('src','scripts','migrations')){Copy-Item (Join-Path $source $name) "$output\app" -Recurse}
Copy-Item "$source\package.json","$source\package-lock.json" "$output\app"
Push-Location "$output\app"
try{
 & $npm ci --omit=dev --ignore-scripts
 if($LASTEXITCODE -ne 0){throw 'Bundled dependency install failed.'}
 & "$output\runtime\node.exe" --input-type=module -e "await import('pg'); await import('@node-rs/argon2');"
 if($LASTEXITCODE -ne 0){throw 'Bundled issuer dependencies could not load.'}
}finally{Pop-Location}
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:exe /reference:System.ServiceProcess.dll /reference:System.Web.Extensions.dll "/out:$output\LeeTLicenseCenterService.exe" "$PSScriptRoot\LicenseCenterService.cs"
if($LASTEXITCODE -ne 0){throw 'License Center service build failed.'}
