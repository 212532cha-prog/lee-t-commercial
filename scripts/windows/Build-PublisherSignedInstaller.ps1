[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidateSet('Warehouse','LicenseCenter')][string]$Product,
 [Parameter(Mandatory=$true)][string]$PayloadDirectory,
 [Parameter(Mandatory=$true)][string]$OutputDirectory,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$CertificateThumbprint,
 [Parameter(Mandatory=$true)][string]$ExpectedSubject,
 [ValidateSet('CurrentUser','LocalMachine')][string]$StoreLocation='CurrentUser',
 [string]$TimestampUrl='http://timestamp.digicert.com',
 [string]$OfflineIssuerPublicKey,
 [string]$OfflineIssuerKeyId,
 [switch]$TestSigning
)
$ErrorActionPreference='Stop'
if($TestSigning -and $env:GITHUB_ACTIONS -ne 'true'){throw 'Test signing is restricted to disposable CI runners.'}
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$source=(Resolve-Path -LiteralPath $PayloadDirectory).Path
$output=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $output){throw 'Choose a new signed output directory; existing packages will not be replaced.'}
if(@(Get-ChildItem -LiteralPath $source -Force -Recurse | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'Linked payload entries cannot be signed.'}
$owned=if($Product -eq 'Warehouse'){@('desktop\LeeT.Warehouse.exe','desktop\LeeT.Warehouse.dll','app\WarehouseService.exe')}else{@('LeeT-License-Center.exe','LeeTLicenseCenterService.exe')}
foreach($relative in $owned){if(-not (Test-Path -LiteralPath (Join-Path $source $relative) -PathType Leaf)){throw ('Missing publisher-owned binary: '+$relative)}}
$compiler=Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
if(-not (Test-Path -LiteralPath $compiler)){throw 'Install Inno Setup 6 before building the signed release.'}
$temporary=$output+'.signing-'+[guid]::NewGuid().ToString('N')
$prior=@{}
$values=@{LEE_T_SIGN_CERTIFICATE=$CertificateThumbprint;LEE_T_SIGN_SUBJECT=$ExpectedSubject;LEE_T_SIGN_STORE=$StoreLocation;LEE_T_SIGN_TIMESTAMP=$TimestampUrl;LEE_T_SIGN_TEST=$(if($TestSigning){'1'}else{'0'})}
foreach($name in $values.Keys){$prior[$name]=[Environment]::GetEnvironmentVariable($name,'Process');[Environment]::SetEnvironmentVariable($name,$values[$name],'Process')}
try{
 $payload=Join-Path $temporary 'payload';$build=Join-Path $temporary 'output';$uninstaller=Join-Path $temporary 'uninstaller'
 New-Item -ItemType Directory -Path $payload,$build,$uninstaller -Force | Out-Null
 Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $payload -Recurse -Force
 $sign=Join-Path $PSScriptRoot 'Sign-WindowsPublisherFile.ps1'
 $records=@()
 foreach($relative in $owned){
  $record=& $sign -Path (Join-Path $payload $relative)
  $records+=@{path=$relative;sha256=$record.Sha256;subject=$record.Subject;thumbprint=$record.Thumbprint;timestamped=$record.Timestamped}
 }
 $optional=if($Product -eq 'LicenseCenter'){'LeeT-License-Center.dll'}else{$null}
 if($optional -and (Test-Path (Join-Path $payload $optional))){$record=& $sign -Path (Join-Path $payload $optional);$records+=@{path=$optional;sha256=$record.Sha256;subject=$record.Subject;thumbprint=$record.Thumbprint;timestamped=$record.Timestamped}}
 $command='$q'+(Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe')+'$q -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $q'+$sign+'$q -Path $f'
 $arguments=@("/DPayloadDir=$payload","/DBuildOutput=$build",'/DPublisherSigning=1',"/DPublisherUninstallerDir=$uninstaller",('/Sleetpublisher='+$command))
 if($Product -eq 'Warehouse'){
  if(-not $OfflineIssuerPublicKey -or -not $OfflineIssuerKeyId){throw 'The existing offline issuer public key and ID are required for Warehouse.'}
  $arguments+=@("/DOfflineIssuerPublicKey=$OfflineIssuerPublicKey","/DOfflineIssuerKeyId=$OfflineIssuerKeyId",(Join-Path $root 'installer\windows\LeeT-Commercial-Setup.iss'))
  $filename='LEE-T-Warehouse-Setup.exe';$name='LEE T Warehouse';$version='0.8.5.0'
 }else{
  $arguments+=(Join-Path $root 'installer\windows\LeeT-LicenseCenter-Setup.iss')
  $filename='LEE-T-License-Center-Setup.exe';$name='LEE T License Center';$version='1.0.0.0'
 }
 & $compiler @arguments | Out-Host
 if($LASTEXITCODE -ne 0){throw 'Signed installer compilation failed; no release output was published.'}
 $setup=Join-Path $build $filename
 $record=& $sign -Path $setup -VerifyOnly
 $records+=@{path=$filename;sha256=$record.Sha256;subject=$record.Subject;thumbprint=$record.Thumbprint;timestamped=$record.Timestamped}
 $cached=@(Get-ChildItem -LiteralPath $uninstaller -Filter '*.e32' -Recurse)
 if($cached.Count -eq 0){throw 'No signed uninstaller was generated.'}
 foreach($file in $cached){$record=& $sign -Path $file.FullName -VerifyOnly;$records+=@{path=('uninstaller/'+$file.Name);sha256=$record.Sha256;subject=$record.Subject;thumbprint=$record.Thumbprint;timestamped=$record.Timestamped}}
 & (Join-Path $PSScriptRoot 'Test-PackageBranding.ps1') -SetupExecutable $setup -ProductName $name -ExpectedVersion $version | Out-Host
 $utf8=[Text.UTF8Encoding]::new($false)
 [IO.File]::WriteAllText((Join-Path $build 'SHA256SUMS.txt'),((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()+'  '+$filename+"`n"),$utf8)
 [IO.File]::WriteAllText((Join-Path $build 'publisher-signatures.json'),(@{schema=1;testSigning=[bool]$TestSigning;files=$records}|ConvertTo-Json -Depth 8),$utf8)
 [IO.Directory]::Move($build,$output)
 Write-Output (Join-Path $output $filename)
}finally{
 foreach($name in $prior.Keys){[Environment]::SetEnvironmentVariable($name,$prior[$name],'Process')}
 if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Recurse -Force}
}
