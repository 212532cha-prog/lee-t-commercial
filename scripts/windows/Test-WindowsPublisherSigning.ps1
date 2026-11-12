#Requires -RunAsAdministrator
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidateSet('Warehouse','LicenseCenter')][string]$Product,
 [Parameter(Mandatory=$true)][string]$PayloadDirectory,
 [string]$OfflineIssuerPublicKey,
 [string]$OfflineIssuerKeyId
)
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
 $certificate=New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject -CertStoreLocation Cert:\CurrentUser\My -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddDays(2)
 $certificates+= $certificate.Thumbprint
 $public=Join-Path $root 'test-publisher.cer';[IO.File]::WriteAllBytes($public,$certificate.RawData)
 Import-Certificate -FilePath $public -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
 $trusted+=$certificate.Thumbprint
 $source=Join-Path $root 'fixture.cs'
 [IO.File]::WriteAllText($source,'class PublisherFixture { static int Main() { return 0; } }')
 & (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe') /nologo /target:exe ("/out:"+$fixture) $source
 if($LASTEXITCODE -ne 0){throw 'Could not compile the native publisher fixture.'}
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
 $badTimestamp=$policy.Clone();$badTimestamp.TimestampUrl='http://127.0.0.1:9/';$rejected=$false
 try{& $sign -Path $fixture @badTimestamp -TestSigning -SignToolTimeoutSeconds 15 | Out-Null}catch{if($_.Exception.Message -notmatch 'timestamp|SignTool'){throw};$rejected=$true}
 if(-not $rejected -or (Get-FileHash $fixture).Hash -ne $originalHash){throw 'Timestamp failure did not retain the original file.'}
 & $sign -Path $fixture @policy -TestSigning | Out-Null
 & $sign -Path $fixture @policy -TestSigning -VerifyOnly | Out-Null
 $tampered=Join-Path $root 'tampered.exe';Copy-Item $fixture $tampered
 $bytes=[IO.File]::ReadAllBytes($tampered);$bytes[512]=$bytes[512] -bxor 1;[IO.File]::WriteAllBytes($tampered,$bytes)
 $rejected=$false
 try{& $sign -Path $tampered @policy -TestSigning -VerifyOnly | Out-Null}catch{if($_.Exception.Message -notmatch 'signature validation failed'){throw};$rejected=$true}
 if(-not $rejected){throw 'A tampered publisher binary passed signature verification.'}
 $output=Join-Path $root 'ci-only-installer'
 & (Join-Path $PSScriptRoot 'Build-PublisherSignedInstaller.ps1') -Product $Product -PayloadDirectory $PayloadDirectory -OutputDirectory $output @policy -OfflineIssuerPublicKey $OfflineIssuerPublicKey -OfflineIssuerKeyId $OfflineIssuerKeyId -TestSigning | Out-Host
 $filename=if($Product -eq 'Warehouse'){'LEE-T-Warehouse-Setup.exe'}else{'LEE-T-License-Center-Setup.exe'}
 & $sign -Path (Join-Path $output $filename) @policy -TestSigning -VerifyOnly | Out-Null
 if($Product -eq 'LicenseCenter'){
  & (Join-Path $PSScriptRoot 'Test-LicenseCenterInstaller.ps1') -SetupExecutable (Join-Path $output $filename) -PublisherCertificateThumbprint $certificate.Thumbprint -PublisherSubject $certificate.Subject -TestPublisherSigning
 }
 Write-Output ('PASS: '+$Product+' publisher signing, SHA256/RFC3161, input preservation on failure, certificate purpose/identity/test-mode guards, tamper rejection, signed payload, installer and uninstaller.')
}finally{
 $env:GITHUB_ACTIONS=$priorCi
 foreach($thumbprint in $trusted){Remove-Item -LiteralPath ('Cert:\CurrentUser\Root\'+$thumbprint) -ErrorAction SilentlyContinue}
 foreach($thumbprint in $certificates){Remove-Item -LiteralPath ('Cert:\CurrentUser\My\'+$thumbprint) -DeleteKey -ErrorAction SilentlyContinue}
 if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force}
}
