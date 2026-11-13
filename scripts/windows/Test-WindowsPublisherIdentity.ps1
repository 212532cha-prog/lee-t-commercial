#Requires -RunAsAdministrator
[CmdletBinding()]
param([scriptblock]$VerifyPackage)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true'){throw 'Publisher signing acceptance requires a disposable CI runner.'}
$root=Join-Path $env:RUNNER_TEMP ('publisher-signing-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$certificates=@();$trusted=@()
$sign=Join-Path $PSScriptRoot 'Sign-WindowsPublisherFile.ps1'
$fixture=Join-Path $root 'publisher-fixture.exe'
$subject='CN=LEE T CI TEST ONLY '+[guid]::NewGuid().ToString('N').Substring(0,8)
$priorCi=$env:GITHUB_ACTIONS
try{
 Write-Host 'Publisher acceptance: create isolated CI code-signing identity.'
 $certificate=New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject -CertStoreLocation Cert:\CurrentUser\My -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddDays(2)
 $certificates+= $certificate.Thumbprint
 $public=Join-Path $root 'test-publisher.cer';[IO.File]::WriteAllBytes($public,$certificate.RawData)
 # CurrentUser Root can display an unattended Windows consent dialog. This elevated, disposable CI host uses its machine store and removes only this unique fixture afterward.
 Write-Host 'Publisher acceptance: trust the public CI fixture on this disposable runner.'
 Import-Certificate -FilePath $public -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
 $trusted+=$certificate.Thumbprint
 $source=Join-Path $root 'fixture.cs'
 [IO.File]::WriteAllText($source,'class PublisherFixture { static int Main() { return 0; } }')
 & (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe') /nologo /target:exe ("/out:"+$fixture) $source
 if($LASTEXITCODE -ne 0){throw 'Could not compile the native publisher fixture.'}
 Write-Host 'Publisher acceptance: verify identity, certificate purpose and production/test guards.'
 $policy=@{CertificateThumbprint=$certificate.Thumbprint;ExpectedSubject=$certificate.Subject;TimestampUrl='http://timestamp.digicert.com'}
 $originalHash=(Get-FileHash -LiteralPath $fixture).Hash
 $rejected=$false
 try{& $sign -Path $fixture @policy | Out-Null}catch{if($_.Exception.Message -notmatch 'Self-signed'){throw};$rejected=$true}
 if(-not $rejected -or (Get-FileHash $fixture).Hash -ne $originalHash){throw 'Production signing accepted a test certificate or changed the input.'}
 $rejected=$false
 try{& $sign -Path $fixture @policy -SkipTimestamp | Out-Null}catch{if($_.Exception.Message -notmatch 'require an RFC 3161 timestamp'){throw};$rejected=$true}
 if(-not $rejected){throw 'Production signing accepted a missing timestamp.'}
 $env:GITHUB_ACTIONS='false';$rejected=$false
 try{& $sign -Path $fixture @policy -TestSigning | Out-Null}catch{if($_.Exception.Message -notmatch 'disposable CI'){throw};$rejected=$true}
 finally{$env:GITHUB_ACTIONS=$priorCi}
 if(-not $rejected){throw 'Test signing was accepted outside CI.'}
 $badSubject=$policy.Clone();$badSubject.ExpectedSubject='CN=Wrong publisher';$rejected=$false
 try{& $sign -Path $fixture @badSubject -TestSigning | Out-Null}catch{if($_.Exception.Message -notmatch 'publisher identity'){throw};$rejected=$true}
 if(-not $rejected -or (Get-FileHash $fixture).Hash -ne $originalHash){throw 'A wrong publisher was accepted or modified the input.'}
 $tls=New-SelfSignedCertificate -Type SSLServerAuthentication -Subject 'CN=TLS IS NOT CODE SIGNING' -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddDays(2)
 $certificates+=$tls.Thumbprint;$rejected=$false
 try{& $sign -Path $fixture -CertificateThumbprint $tls.Thumbprint -ExpectedSubject $tls.Subject -TimestampUrl $policy.TimestampUrl -TestSigning | Out-Null}catch{if($_.Exception.Message -notmatch 'code-signing certificate'){throw};$rejected=$true}
 if(-not $rejected){throw 'A TLS certificate was accepted for publisher signing.'}
 Write-Host 'Publisher acceptance: reject a failed timestamp without changing the input.'
 $badTimestamp=$policy.Clone();$badTimestamp.TimestampUrl='http://127.0.0.1:9/';$rejected=$false
 try{& $sign -Path $fixture @badTimestamp -TestSigning -SignToolTimeoutSeconds 15 | Out-Null}catch{if($_.Exception.Message -notmatch 'timestamp|SignTool'){throw};$rejected=$true}
 if(-not $rejected -or (Get-FileHash $fixture).Hash -ne $originalHash){throw 'Timestamp failure did not retain the original file.'}
 Write-Host 'Publisher acceptance: terminate a stalled timestamp request and preserve its original input.'
 $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
 $listener.Start();$accepted=$listener.AcceptTcpClientAsync()
 $stalled=$policy.Clone();$stalled.TimestampUrl='http://127.0.0.1:'+([Net.IPEndPoint]$listener.LocalEndpoint).Port+'/'
 $clock=[Diagnostics.Stopwatch]::StartNew();$rejected=$false
 try{
  try{& $sign -Path $fixture @stalled -TestSigning -SignToolTimeoutSeconds 15 | Out-Null}catch{if($_.Exception.Message -notmatch 'timed out'){throw};$rejected=$true}
  if(-not $rejected -or -not $accepted.IsCompleted -or $clock.Elapsed.TotalSeconds -gt 30 -or (Get-FileHash $fixture).Hash -ne $originalHash){throw 'A stalled timestamp request was not bounded or changed the original file.'}
 }finally{
  if($accepted.Status -eq [Threading.Tasks.TaskStatus]::RanToCompletion){$accepted.Result.Dispose()}
  $listener.Stop();$clock.Stop()
 }
 Write-Host 'Publisher acceptance: sign with SHA256 and a real RFC3161 timestamp.'
 & $sign -Path $fixture @policy -TestSigning | Out-Null
 & $sign -Path $fixture @policy -TestSigning -VerifyOnly | Out-Null
 $tampered=Join-Path $root 'tampered.exe';Copy-Item $fixture $tampered
 $bytes=[IO.File]::ReadAllBytes($tampered);$bytes[512]=$bytes[512] -bxor 1;[IO.File]::WriteAllBytes($tampered,$bytes)
 $rejected=$false
 try{& $sign -Path $tampered @policy -TestSigning -VerifyOnly | Out-Null}catch{if($_.Exception.Message -notmatch 'signature validation failed'){throw};$rejected=$true}
 if(-not $rejected){throw 'A tampered publisher binary passed signature verification.'}
 Write-Host 'PASS: publisher identity, SHA256/RFC3161, atomic replacement, failed-request input preservation and tamper rejection.'
 if($VerifyPackage){& $VerifyPackage $policy $root}
}finally{
 $env:GITHUB_ACTIONS=$priorCi
 foreach($thumbprint in $trusted){Remove-Item -LiteralPath ('Cert:\LocalMachine\Root\'+$thumbprint) -ErrorAction SilentlyContinue}
 foreach($thumbprint in $certificates){Remove-Item -LiteralPath ('Cert:\CurrentUser\My\'+$thumbprint) -DeleteKey -ErrorAction SilentlyContinue}
 if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force}
}
