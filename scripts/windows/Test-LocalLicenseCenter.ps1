#Requires -RunAsAdministrator
param([string]$DesktopExecutable)
$ErrorActionPreference='Stop'
$root=Join-Path $env:RUNNER_TEMP ('leet-issuer-'+[guid]::NewGuid().ToString('N'))
$node=(Get-Command node.exe).Source
$postgres=Join-Path $env:ProgramFiles 'PostgreSQL\17'
$service='LeeTLicensePostgreSQL17-'+[guid]::NewGuid().ToString('N').Substring(0,8)
$process=$null
$provisioned=$false
$certificates=@()
$priorConfig=$env:LEE_T_MANAGEMENT_CONFIG
$priorMode=$env:LEE_T_OFFLINE_ONLY
$testPassword=[guid]::NewGuid().ToString('N')
$databaseListener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$managementListener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
try{
 $databaseListener.Start()
 $managementListener.Start()
 $databasePort=$databaseListener.LocalEndpoint.Port
 $managementPort=$managementListener.LocalEndpoint.Port
 $databaseListener.Stop()
 $managementListener.Stop()
 $arguments=@{
  PostgresDirectory=$postgres;NodePath=$node;Root=$root;DatabaseServiceName=$service
  DatabasePort=$databasePort;ManagementPort=$managementPort
  OperatorPassword=(ConvertTo-SecureString $testPassword -AsPlainText -Force)
 }
 & (Join-Path $PSScriptRoot 'Initialize-LocalLicenseCenter.ps1') @arguments
 $provisioned=$true
 $ca=[Security.Cryptography.X509Certificates.X509Certificate2]::new((Join-Path $root 'management-ca.cer'))
 $operator=[Security.Cryptography.X509Certificates.X509Certificate2]::new((Join-Path $root 'operator.cer'))
 $certificates=@(Get-ChildItem Cert:\CurrentUser\My | Where-Object {$_.Thumbprint -eq $ca.Thumbprint -or $_.Issuer -eq $ca.Subject})
 $client=Get-Item -LiteralPath ('Cert:\CurrentUser\My\'+$operator.Thumbprint)
 if(-not $client.HasPrivateKey){throw 'The issuer certificate is missing its operator private key.'}
 $blocked=$false
 try{& (Join-Path $PSScriptRoot 'Initialize-LocalLicenseCenter.ps1') @arguments}
 catch{if($_.Exception.Message -notlike '*Existing issuer data*'){throw};$blocked=$true}
 if(-not $blocked){throw 'Existing issuer setup was not preserved.'}
 $env:LEE_T_MANAGEMENT_CONFIG=Join-Path $root 'management.private.json'
 if($DesktopExecutable){$env:LEE_T_OFFLINE_ONLY='1'}
 $script=Join-Path $PSScriptRoot '..\start-license-management.mjs'
 $process=Start-Process -FilePath $node -ArgumentList ('"'+$script+'"') -PassThru -RedirectStandardOutput (Join-Path $root 'stdout.log') -RedirectStandardError (Join-Path $root 'stderr.log')
 $ready=$false
 for($attempt=0;$attempt -lt 100;$attempt++){
  if($process.HasExited){throw 'The local management server exited before readiness.'}
  if((Get-Content -LiteralPath (Join-Path $root 'stdout.log') -Raw) -match 'management ready'){$ready=$true;break}
  Start-Sleep -Milliseconds 150
 }
 if(-not $ready){throw 'The local management server did not start.'}
 $origin='https://127.0.0.1:'+$managementPort
 $auth='Basic '+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('issuer:'+$testPassword))
 function Call-Management([string]$Path,$Body){
  Invoke-RestMethod -Uri ($origin+$Path) -Method Post -Certificate $client -Headers @{Authorization=$auth;Origin=$origin} -ContentType 'application/json' -Body ($Body|ConvertTo-Json -Depth 8 -Compress)
 }
 $customer=Call-Management '/api/customers' @{companyName='Isolated Windows issuer fixture'}
 $payment=Call-Management '/api/payments' @{customerId=$customer.id;receiptReference='windows-issuer-fixture';kind='initial';version='0.8.5'}
 $request=@{schema=1;product='lee-t-warehouse';installationId=[guid]::NewGuid().ToString();claims=@{machineId=('a'*64);boardId=('b'*64);systemDiskId=('c'*64)}}
 $signed=Call-Management '/api/sign-offline' @{customerId=$customer.id;paymentId=$payment.id;request=$request}
 if(-not $signed.signature -or $signed.payload.installationId -ne $request.installationId){throw 'The local issuer did not sign the intended installation.'}
 $retry=Call-Management '/api/sign-offline' @{customerId=$customer.id;paymentId=$payment.id;request=$request}
 if($retry.signature -ne $signed.signature){throw 'The local issuer did not return the original license.'}
 $signatureCheck=@'
import {readFileSync} from 'node:fs';
import {verifyLicense} from './src/commercial/license.mjs';
const {license,request,publicKeyPath}=JSON.parse(readFileSync(process.argv[1],'utf8'));
const publicKeyPem=readFileSync(publicKeyPath,'utf8');
if(!verifyLicense({license,request,publicKeyPem,runningVersion:'0.8.5'}).valid)process.exitCode=1;
'@
 $verification=@{license=$signed;request=$request;publicKeyPath=(Join-Path $root 'issuer-public.pem')}|ConvertTo-Json -Depth 10 -Compress
 # Write exact UTF-8 bytes instead of using the Windows PowerShell native pipeline.
 $verificationPath=Join-Path $root 'signature-check.json'
 [IO.File]::WriteAllText($verificationPath,$verification,[Text.UTF8Encoding]::new($false))
 & $node --input-type=module -e $signatureCheck -- $verificationPath
 if($LASTEXITCODE -ne 0){throw 'The generated publisher key did not verify the signed license.'}
 if($DesktopExecutable){
  $denied=$false
  try{Call-Management '/api/issue' @{customerId=$customer.id;paymentId=$payment.id} | Out-Null}
  catch{if([int]$_.Exception.Response.StatusCode -ne 404){throw};$denied=$true}
  if(-not $denied){throw 'Offline-only management accepted an online activation endpoint.'}
  $passwordFile=Join-Path $root 'desktop-password.txt'
  $requestFile=Join-Path $root 'desktop-request.json'
  $outputFile=Join-Path $root 'desktop-license.json'
  $utf8=[Text.UTF8Encoding]::new($false)
  [IO.File]::WriteAllText($passwordFile,$testPassword,$utf8)
  [IO.File]::WriteAllText($requestFile,($request|ConvertTo-Json -Depth 8 -Compress),$utf8)
  $desktop=Start-Process -FilePath $DesktopExecutable -ArgumentList @('--test',('"' + $root + '"'),('"' + $passwordFile + '"'),('"' + $requestFile + '"'),('"' + $outputFile + '"')) -PassThru
  if(-not $desktop.WaitForExit(90000)){$desktop.Kill();throw 'The desktop issuer test timed out.'}
  if($desktop.ExitCode -ne 0){throw 'The desktop issuer integration failed.'}
  $desktopLicense=Get-Content -LiteralPath $outputFile -Raw | ConvertFrom-Json
  [IO.File]::WriteAllText($verificationPath,(@{license=$desktopLicense;request=$request;publicKeyPath=(Join-Path $root 'issuer-public.pem')}|ConvertTo-Json -Depth 12 -Compress),$utf8)
  & $node --input-type=module -e $signatureCheck -- $verificationPath
  if($LASTEXITCODE -ne 0){throw 'The desktop issuer output failed independent signature verification.'}
 }
 Write-Output 'Windows local issuer setup, TLS operator login, paid signing and exact retry passed.'
}finally{
 $databaseListener.Stop()
 $managementListener.Stop()
 $env:LEE_T_MANAGEMENT_CONFIG=$priorConfig
 $env:LEE_T_OFFLINE_ONLY=$priorMode
 if($process -and -not $process.HasExited){Stop-Process -Id $process.Id -Force; $process.WaitForExit()}
 if($provisioned){
  if($ca){Remove-Item -LiteralPath ('Cert:\LocalMachine\Root\'+$ca.Thumbprint) -ErrorAction SilentlyContinue}
  foreach($certificate in $certificates){Remove-Item -LiteralPath ('Cert:\CurrentUser\My\'+$certificate.Thumbprint) -ErrorAction SilentlyContinue}
  Stop-Service -Name $service -ErrorAction SilentlyContinue
  & (Join-Path $postgres 'bin\pg_ctl.exe') unregister -N $service | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Could not remove the isolated issuer database service.'}
  Remove-Item -LiteralPath $root -Recurse -Force
 }
}
