#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$DesktopTestExecutable)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('leet-desktop-test-'+[guid]::NewGuid().ToString('N'))
$certificate=$null
$fixture=$null
$test=$null
try {
 $certificate=& (Join-Path $PSScriptRoot 'New-LanCertificate.ps1') -Address '192.168.10.25' -Directory $temporary -TrustLocally
 $env:LEET_DESKTOP_TEST_PFX=$certificate.PfxPath
 $env:LEET_DESKTOP_TEST_PASSPHRASE=$certificate.Passphrase
 $fixture=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList ('"'+(Join-Path $root 'desktop\tests\fixture.mjs')+'"') -PassThru
 $started=$false
 for($attempt=0;$attempt -lt 40;$attempt++){
  if($fixture.HasExited){throw 'Desktop HTTPS fixture exited early.'}
  $connection=New-Object Net.Sockets.TcpClient
  try{$connection.Connect('127.0.0.1',3443);$started=$true;break}catch{Start-Sleep -Milliseconds 250}finally{$connection.Dispose()}
 }
 if(-not $started){throw 'Desktop HTTPS fixture did not start.'}
 $test=Start-Process -FilePath $DesktopTestExecutable -PassThru -RedirectStandardOutput (Join-Path $temporary 'stdout.log') -RedirectStandardError (Join-Path $temporary 'stderr.log')
 if(-not $test.WaitForExit(120000)){throw 'Desktop test timed out.'}
 Get-Content -LiteralPath (Join-Path $temporary 'stdout.log')
 Get-Content -LiteralPath (Join-Path $temporary 'stderr.log')
 if($test.ExitCode -ne 0){throw 'Desktop window tests failed.'}
} finally {
 foreach($process in @($test,$fixture)){if($process -and -not $process.HasExited){Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue}}
 Remove-Item Env:LEET_DESKTOP_TEST_PFX,Env:LEET_DESKTOP_TEST_PASSPHRASE -ErrorAction SilentlyContinue
 if($certificate){
  Remove-Item -LiteralPath ('Cert:\LocalMachine\Root\'+$certificate.RootThumbprint) -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath ('Cert:\LocalMachine\My\'+$certificate.RootThumbprint) -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath ('Cert:\LocalMachine\My\'+$certificate.LeafThumbprint) -ErrorAction SilentlyContinue
 }
 if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Recurse -Force}
}
