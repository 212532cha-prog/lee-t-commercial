#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$DesktopTestExecutable,[string]$ManagementDirectory,[Parameter(Mandatory=$true)][string]$ActivationPayloadDirectory)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('leet-desktop-test-'+[guid]::NewGuid().ToString('N'))
$certificate=$null
$fixture=$null
$test=$null
$activationEntry=$null
$cluster=$null
$clusterStarted=$false
$fixtureKeys=@('PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','WAREHOUSE_NATIVE_PG','LEET_DESKTOP_TEST_RUOYI_DIR','LEET_DESKTOP_TEST_ROOT','LEET_DESKTOP_TEST_CERT','LEET_DESKTOP_TEST_PASSWORD','LEET_DESKTOP_MANAGEMENT','LEET_ACTIVATION_TEST_ROOT','LEET_ACTIVATION_TEST_SOURCE','LEET_ACTIVATION_TEST_NODE')
$previousFixtureEnvironment=@{}
foreach($key in $fixtureKeys){$previousFixtureEnvironment[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
try {
 $certificate=& (Join-Path $PSScriptRoot 'New-LanCertificate.ps1') -Address '192.168.10.25' -Directory $temporary -TrustLocally
 $env:LEET_DESKTOP_TEST_PFX=$certificate.PfxPath
 $env:LEET_DESKTOP_TEST_PASSPHRASE=$certificate.Passphrase
 $activationRoot=Join-Path $temporary 'activation-ui'
 $activationPayload=Join-Path $activationRoot 'payload'
 foreach($folder in @('desktop','runtime','app\scripts')){New-Item -ItemType Directory -Path (Join-Path $activationPayload $folder) -Force | Out-Null}
 Get-ChildItem -LiteralPath (Join-Path $ActivationPayloadDirectory 'desktop') | Copy-Item -Destination (Join-Path $activationPayload 'desktop') -Recurse
 Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $activationPayload 'runtime\node.exe')
 # Copy the real bridge and its built-in-only dependencies for the fixed installed-path check.
 Copy-Item -LiteralPath (Join-Path $root 'scripts\desktop-activation.mjs') -Destination (Join-Path $activationPayload 'app\scripts\desktop-activation.mjs')
 Copy-Item -LiteralPath (Join-Path $root 'src') -Destination (Join-Path $activationPayload 'app\src') -Recurse
 Copy-Item -LiteralPath (Join-Path $root 'package.json') -Destination (Join-Path $activationPayload 'app\package.json')
 foreach($path in @('runtime\node.exe','app\scripts','app\scripts\desktop-activation.mjs','app\src\commercial\license.mjs')){
  & icacls.exe (Join-Path $activationPayload $path) '/grant:r' '*S-1-5-32-545:F' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Cannot stage copied-file permission regression.'}
 }
 & node (Join-Path $root 'desktop\tests\prepare-activation-fixture.mjs') $activationRoot prepare
 if($LASTEXITCODE -ne 0){throw 'Activation signing fixture failed.'}
 $activationSettings=@{
  PayloadDirectory=$activationPayload
  LicenseDirectory=(Join-Path $activationRoot 'license')
  IssuerPublicKey=(Join-Path $activationRoot 'issuer.pem')
  IssuerKeyId='desktop-ui-test'
  ActivationEndpoint='https://activation.example.test/redeem'
 }
 $prepareActivation=Join-Path $PSScriptRoot 'New-DesktopActivationConfig.ps1'
 & $prepareActivation @activationSettings
 $identityPath=Join-Path $activationSettings.LicenseDirectory 'installation-id'
 $identity=[guid]::NewGuid().ToString()
 [IO.File]::WriteAllText($identityPath,$identity)
 $identityAcl=Get-Acl -LiteralPath $identityPath
 $identityAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
 Set-Acl -LiteralPath $identityPath -AclObject $identityAcl
 & $prepareActivation @activationSettings -Resume
 if([IO.File]::ReadAllText($identityPath) -cne $identity){throw 'Resuming setup changed the installation identity.'}
 $activationSettings.ActivationEndpoint='https://other.example.test/redeem'
 $resumeRejected=$false
 try{& $prepareActivation @activationSettings -Resume}catch{
  if($_.Exception.Message -ne 'Activation setup settings have changed.'){throw}
  $resumeRejected=$true
 }
 if(-not $resumeRejected -or [IO.File]::ReadAllText($identityPath) -cne $identity){throw 'Changed activation trust must be rejected without changing the identity.'}
 Remove-Item -LiteralPath $identityPath
 # The installer extracts a new bootstrap on each run. The device identity and
 # pinned issuer must survive removing the entire previous bootstrap.
 $cache=Join-Path $activationRoot 'installer-cache'
 $bootstrap=Join-Path $activationRoot 'bootstrap'
 $activationSettings.LicenseDirectory=$cache
 $activationSettings.PayloadDirectory=$bootstrap
 $activationSettings.ActivationEndpoint='https://activation.example.test/redeem'
 $cacheIdentity=Join-Path $cache 'installation-id'
 for($run=0;$run -lt 2;$run++){
  foreach($folder in @('desktop','runtime','app\scripts')){
   New-Item -ItemType Directory -Path (Join-Path $bootstrap $folder) -Force | Out-Null
  }
  foreach($file in @('desktop\LeeT.Warehouse.exe','runtime\node.exe','app\scripts\desktop-activation.mjs')){
   Copy-Item -LiteralPath (Join-Path $activationPayload $file) -Destination (Join-Path $bootstrap $file)
  }
  & $prepareActivation @activationSettings -InstallerCache
  $bootConfig=Get-Content -LiteralPath (Join-Path $bootstrap 'desktop\activation.private.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if($bootConfig.Environment.LEE_T_LICENSE_DIR -cne $cache -or
     $bootConfig.Environment.LEE_T_ISSUER_PUBLIC_KEY_PATH -cne (Join-Path $cache 'issuer-public.pem')){
   throw 'Installer bootstrap did not use the protected cache.'
  }
  if($run -eq 0){
   [IO.File]::WriteAllText($cacheIdentity,$identity)
   $cachedAcl=Get-Acl -LiteralPath $cacheIdentity
   $cachedAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
   Set-Acl -LiteralPath $cacheIdentity -AclObject $cachedAcl
  }elseif([IO.File]::ReadAllText($cacheIdentity) -cne $identity){
   throw 'A fresh installer bootstrap replaced the existing installation identity.'
  }
  Remove-Item -LiteralPath $bootstrap -Recurse -Force
  $bootstrap=Join-Path $activationRoot 'bootstrap-reopened'
  $activationSettings.PayloadDirectory=$bootstrap
 }
 Write-Output 'Installer cache preserves identity and issuer across freshly extracted bootstraps.'

 # Regression: an unactivated cache from the previous publisher must accept the
 # new bundled public trust without losing the exported installation identity.
 foreach($folder in @('desktop','runtime','app\scripts')){
  New-Item -ItemType Directory -Path (Join-Path $bootstrap $folder) -Force | Out-Null
 }
 foreach($file in @('desktop\LeeT.Warehouse.exe','runtime\node.exe','app\scripts\desktop-activation.mjs')){
  Copy-Item -LiteralPath (Join-Path $activationPayload $file) -Destination (Join-Path $bootstrap $file)
 }
 $publisher=Get-Content -LiteralPath (Join-Path $root 'installer\windows\publisher.json') -Raw | ConvertFrom-Json
 $nextIssuer=Join-Path $activationRoot 'replacement-issuer'
 New-Item -ItemType Directory -Path $nextIssuer | Out-Null
 $previousPublic=$env:LEE_T_OFFLINE_ISSUER_PUBLIC_KEY
 $previousKeyId=$env:LEE_T_OFFLINE_ISSUER_KEY_ID
 try{
  $env:LEE_T_OFFLINE_ISSUER_PUBLIC_KEY=$publisher.publicKeySpkiBase64
  $env:LEE_T_OFFLINE_ISSUER_KEY_ID=$publisher.keyId
  & node (Join-Path $root 'scripts\windows\prepare-offline-issuer.mjs') $nextIssuer
  if($LASTEXITCODE -ne 0){throw 'The configured publisher could not be staged.'}
 }finally{
  $env:LEE_T_OFFLINE_ISSUER_PUBLIC_KEY=$previousPublic
  $env:LEE_T_OFFLINE_ISSUER_KEY_ID=$previousKeyId
 }
 $activationSettings.IssuerPublicKey=Join-Path $nextIssuer 'issuer-public.pem'
 $activationSettings.IssuerKeyId=$publisher.keyId
 $oldTrustHash=(Get-FileHash -LiteralPath (Join-Path $cache 'issuer-public.pem')).Hash
 $rejected=$false
 try{& $prepareActivation @activationSettings -InstallerCache}catch{
  if($_.Exception.Message -ne 'Activation setup settings have changed.'){throw}
  $rejected=$true
 }
 if(-not $rejected -or (Get-FileHash -LiteralPath (Join-Path $cache 'issuer-public.pem')).Hash -ne $oldTrustHash){throw 'An ordinary resume must not replace pinned issuer trust.'}
 & $prepareActivation @activationSettings -InstallerCache -ReplaceUnactivatedIssuer
 $nextTrustHash=(Get-FileHash -LiteralPath $activationSettings.IssuerPublicKey).Hash
 $savedCache=Get-Content -LiteralPath (Join-Path $cache 'setup.private.json') -Raw | ConvertFrom-Json
 if([IO.File]::ReadAllText($cacheIdentity) -cne $identity -or
    (Get-FileHash -LiteralPath (Join-Path $cache 'issuer-public.pem')).Hash -ne $nextTrustHash -or
    $savedCache.Environment.LEE_T_ISSUER_KEY_ID -cne $publisher.keyId){throw 'Unactivated issuer replacement did not preserve identity and update matching public trust.'}
 & $prepareActivation @activationSettings -InstallerCache
 # Never rotate a cache containing a license, even when the replacement flag is set.
 $cachedLicense=Join-Path $cache 'license.json'
 [IO.File]::WriteAllText($cachedLicense,'protected-license-placeholder')
 $cachedAcl=Get-Acl -LiteralPath $cachedLicense
 $cachedAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
 Set-Acl -LiteralPath $cachedLicense -AclObject $cachedAcl
 $activationSettings.IssuerPublicKey=Join-Path $activationRoot 'issuer.pem'
 $activationSettings.IssuerKeyId='desktop-ui-test'
 $rejected=$false
 try{& $prepareActivation @activationSettings -InstallerCache -ReplaceUnactivatedIssuer}catch{
  if($_.Exception.Message -ne 'Activated installations cannot replace their issuer trust.'){throw}
  $rejected=$true
 }
 if(-not $rejected -or [IO.File]::ReadAllText($cachedLicense) -cne 'protected-license-placeholder' -or
    [IO.File]::ReadAllText($cacheIdentity) -cne $identity -or
    (Get-FileHash -LiteralPath (Join-Path $cache 'issuer-public.pem')).Hash -ne $nextTrustHash){throw 'Existing licenses and their issuer trust were not preserved.'}
 Remove-Item -LiteralPath $bootstrap -Recurse -Force
 Write-Output 'Publisher replacement: explicit unactivated-only rollover preserves identity, resumes safely and refuses existing licenses.'
 $activationExe=Join-Path $activationPayload 'desktop\LeeT.Warehouse.exe'
 $activationEntry=Start-Process -FilePath $activationExe -ArgumentList '--activate' -PassThru
 [void]$activationEntry.Handle
 for($attempt=0;$attempt -lt 100;$attempt++){
  $activationEntry.Refresh()
  if($activationEntry.HasExited){throw 'Native activation entry exited before showing its window.'}
  if($activationEntry.MainWindowHandle -ne [IntPtr]::Zero){break}
  Start-Sleep -Milliseconds 100
 }
 if($activationEntry.MainWindowTitle -ne 'Activate LEE T Warehouse' -or -not $activationEntry.CloseMainWindow()){throw 'Native activation window did not open.'}
 if(-not $activationEntry.WaitForExit(10000)){throw 'Closing the native activation window did not terminate setup mode.'}
 $activationEntry.Refresh()
 if($activationEntry.ExitCode -ne 10){throw "Activation cancellation must return exit code 10. Actual: $($activationEntry.ExitCode)."}
 $activationEntry=Start-Process -FilePath $activationExe -ArgumentList '--unexpected-argument' -PassThru
 [void]$activationEntry.Handle
 if(-not $activationEntry.WaitForExit(10000)){throw 'Invalid activation arguments did not terminate.'}
 $activationEntry.Refresh()
 if($activationEntry.ExitCode -ne 2){throw 'Unexpected activation arguments must be rejected.'}
 Write-Output 'Actual desktop executable: native activation window/close exit 10 and invalid-argument exit 2 passed.'
 $env:LEET_ACTIVATION_TEST_ROOT=$activationRoot
 $env:LEET_ACTIVATION_TEST_SOURCE=$root
 $env:LEET_ACTIVATION_TEST_NODE=(Get-Command node.exe).Source
 $fixtureScript=Join-Path $root 'desktop\tests\fixture.mjs'
 if($ManagementDirectory){
  $management=(Resolve-Path -LiteralPath $ManagementDirectory).Path
  & node (Join-Path $root 'scripts\verify-ruoyi-bundle.mjs') verify $management
  if($LASTEXITCODE -ne 0){throw 'Management test requires the verified built bundle.'}
  $pgBin=Join-Path $env:ProgramFiles 'PostgreSQL\17\bin'
  if(-not (Test-Path -LiteralPath (Join-Path $pgBin 'initdb.exe'))){throw 'PostgreSQL 17 is required; the desktop test has no fallback.'}
  if(Get-NetTCPConnection -LocalPort 55434 -State Listen -ErrorAction SilentlyContinue){throw 'Desktop test PostgreSQL port is occupied.'}
  $cluster=Join-Path $temporary 'test-cluster'
  $databaseSecret=[guid]::NewGuid().ToString('N')
  $secretFile=Join-Path $temporary 'init.private'
  [IO.File]::WriteAllText($secretFile,$databaseSecret,[Text.UTF8Encoding]::new($false))
  & (Join-Path $pgBin 'initdb.exe') -D $cluster -U postgres -A scram-sha-256 --pwfile $secretFile --encoding=UTF8 --locale=C
  if($LASTEXITCODE -ne 0){throw 'Desktop test cluster initialization failed.'}
  Remove-Item -LiteralPath $secretFile -Force
  & (Join-Path $pgBin 'pg_ctl.exe') -D $cluster -l (Join-Path $temporary 'postgres.log') -o '-h 127.0.0.1 -p 55434' -w start
  if($LASTEXITCODE -ne 0){throw 'Desktop test PostgreSQL failed to start.'}
  $clusterStarted=$true
  $env:PGHOST='127.0.0.1';$env:PGPORT='55434';$env:PGUSER='postgres';$env:PGPASSWORD=$databaseSecret;$env:PGDATABASE='warehouse_test';$env:WAREHOUSE_NATIVE_PG='1'
  & (Join-Path $pgBin 'createdb.exe') warehouse_test
  if($LASTEXITCODE -ne 0){throw 'Desktop test database creation failed.'}
  $env:LEET_DESKTOP_MANAGEMENT='1'
  $env:LEET_DESKTOP_TEST_RUOYI_DIR=$management
  $env:LEET_DESKTOP_TEST_ROOT=$temporary
  $env:LEET_DESKTOP_TEST_CERT=$certificate.LeafCertificate
  $env:LEET_DESKTOP_TEST_PASSWORD=[guid]::NewGuid().ToString('N')
  $fixtureScript=Join-Path $root 'desktop\tests\management-fixture.mjs'
 }
 $fixture=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList ('"'+$fixtureScript+'"') -PassThru -RedirectStandardOutput (Join-Path $temporary 'fixture.stdout.log') -RedirectStandardError (Join-Path $temporary 'fixture.stderr.log')
 $started=$false
 for($attempt=0;$attempt -lt 120;$attempt++){
  if($fixture.HasExited){Get-Content -LiteralPath (Join-Path $temporary 'fixture.stderr.log');throw 'Desktop HTTPS fixture exited early.'}
  $connection=New-Object Net.Sockets.TcpClient
  try{$connection.Connect('127.0.0.1',3443);$started=$true;break}catch{Start-Sleep -Milliseconds 250}finally{$connection.Dispose()}
 }
 if(-not $started){throw 'Desktop HTTPS fixture did not start.'}
 $test=Start-Process -FilePath $DesktopTestExecutable -PassThru -RedirectStandardOutput (Join-Path $temporary 'stdout.log') -RedirectStandardError (Join-Path $temporary 'stderr.log')
 [void]$test.Handle
 if(-not $test.WaitForExit(180000)){throw 'Desktop test timed out.'}
 $test.Refresh()
 Get-Content -LiteralPath (Join-Path $temporary 'stdout.log')
 Get-Content -LiteralPath (Join-Path $temporary 'stderr.log')
 $qaRoot=if($env:RUNNER_TEMP){$env:RUNNER_TEMP}else{$env:TEMP}
 $qa=Join-Path $qaRoot 'leet-activation-preview'
 New-Item -ItemType Directory -Path $qa -Force | Out-Null
 Get-ChildItem -LiteralPath $activationRoot -Filter '*.png' | Copy-Item -Destination $qa
 Write-Output ('Desktop process exit code: '+$test.ExitCode)
 if($null -eq $test.ExitCode -or $test.ExitCode -ne 0){throw 'Desktop window tests failed.'}
} finally {
 foreach($process in @($test,$fixture,$activationEntry)){if($process -and -not $process.HasExited){Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue}}
 if($clusterStarted -and (Test-Path -LiteralPath $cluster)){& (Join-Path $pgBin 'pg_ctl.exe') -D $cluster -m fast -w stop | Out-Null}
 foreach($key in $fixtureKeys){[Environment]::SetEnvironmentVariable($key,$previousFixtureEnvironment[$key],'Process')}
 Remove-Item Env:LEET_DESKTOP_TEST_PFX,Env:LEET_DESKTOP_TEST_PASSPHRASE -ErrorAction SilentlyContinue
 if($certificate){
  Remove-Item -LiteralPath ('Cert:\LocalMachine\Root\'+$certificate.RootThumbprint) -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath ('Cert:\LocalMachine\My\'+$certificate.RootThumbprint) -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath ('Cert:\LocalMachine\My\'+$certificate.LeafThumbprint) -ErrorAction SilentlyContinue
 }
 if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Recurse -Force}
}
