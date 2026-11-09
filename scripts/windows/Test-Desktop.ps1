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
 & (Join-Path $PSScriptRoot 'New-DesktopActivationConfig.ps1') -PayloadDirectory $activationPayload -LicenseDirectory (Join-Path $activationRoot 'license') -IssuerPublicKey (Join-Path $activationRoot 'issuer.pem') -IssuerKeyId 'desktop-ui-test' -ActivationEndpoint 'https://activation.example.test/redeem'
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
