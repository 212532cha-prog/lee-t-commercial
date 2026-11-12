#Requires -RunAsAdministrator
param([Parameter(Mandatory=$true)][string]$SetupExecutable)
$ErrorActionPreference='Stop'
$root=Join-Path $env:ProgramData 'Lee T License Center'
$install=Join-Path $env:ProgramFiles 'LEE T License Center'
if((Test-Path $root) -or (Test-Path $install) -or (Get-Service 'LeeTLicenseCenter' -ErrorAction SilentlyContinue) -or (Get-Service 'LeeTLicensePostgreSQL17' -ErrorAction SilentlyContinue)){
 throw 'Installer acceptance requires a clean Windows runner; existing user data will never be used.'
}
$fixture=Join-Path $env:RUNNER_TEMP ('license-installer-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
& icacls.exe $fixture /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not protect acceptance fixture.'}
$passwordFile=Join-Path $fixture 'password.txt'
$requestFile=Join-Path $fixture 'request.json'
$outputFile=Join-Path $fixture 'license.json'
$utf8=[Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($passwordFile,[guid]::NewGuid().ToString('N'),$utf8)
$request=@{schema=1;product='lee-t-warehouse';installationId=[guid]::NewGuid().ToString();claims=@{machineId=('a'*64);boardId=('b'*64);systemDiskId=('c'*64)}}
[IO.File]::WriteAllText($requestFile,($request|ConvertTo-Json -Depth 8 -Compress),$utf8)
function Install-Issuer {
 $process=Start-Process -FilePath $SetupExecutable -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/IssuerPasswordFile="'+$passwordFile+'"'),('/LOG="'+(Join-Path $fixture ('setup-'+[guid]::NewGuid().ToString('N')+'.log'))+'"')) -PassThru
 if(-not $process.WaitForExit(300000)){$process.Kill();throw 'Standalone installer timed out.'}
 if($process.ExitCode -ne 0){throw 'Standalone installer failed.'}
}
function Test-Signing {
 $process=Start-Process -FilePath (Join-Path $install 'LeeT-License-Center.exe') -ArgumentList @('--test',('"'+$root+'"'),('"'+$passwordFile+'"'),('"'+$requestFile+'"'),('"'+$outputFile+'"')) -PassThru
 if(-not $process.WaitForExit(90000)){$process.Kill();throw 'Installed signing test timed out.'}
 if($process.ExitCode -ne 0){throw 'Installed desktop failed customer/payment/signing or invalid-password rejection.'}
 $verification=Join-Path $fixture 'verify.mjs'
 [IO.File]::WriteAllText($verification,@'
import {readFileSync} from 'node:fs';
import {createPublicKey,verify} from 'node:crypto';
const [licensePath,keyPath]=process.argv.slice(2);
const license=JSON.parse(readFileSync(licensePath,'utf8'));
function canonical(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';}
if(!verify(null,Buffer.from(canonical(license.payload)),createPublicKey(readFileSync(keyPath)),Buffer.from(license.signature,'base64url')))throw Error('Invalid issuer signature');
'@,$utf8)
 & (Join-Path $install 'runtime\node.exe') $verification $outputFile (Join-Path $root 'issuer-public.pem')
 if($LASTEXITCODE -ne 0){throw 'Independent signature verification failed.'}
}
function Uninstall-Issuer([bool]$DeleteData){
 $arguments=@('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART')
 if($DeleteData){$arguments+='/DeleteIssuerData=1'}
 $process=Start-Process (Join-Path $install 'unins000.exe') -ArgumentList $arguments -PassThru
 if(-not $process.WaitForExit(180000)){$process.Kill();throw 'Issuer uninstaller timed out.'}
 if($process.ExitCode -ne 0){throw 'Issuer uninstall failed.'}
}
try{
 Install-Issuer
 foreach($name in @('LeeTLicenseCenter','LeeTLicensePostgreSQL17')){
  $service=Get-CimInstance Win32_Service -Filter "Name='$name'"
  if($service.StartMode -ne 'Auto' -or $service.State -ne 'Running' -or -not $service.PathName.StartsWith('"'+$install+'\')){throw 'Services must run automatically from the independent installation.'}
 }
 Test-Signing
 $keyHash=(Get-FileHash (Join-Path $root 'issuer.key')).Hash
 $configHash=(Get-FileHash (Join-Path $root 'management.private.json')).Hash
 # Cold service start: SCM must bring up its PostgreSQL dependency without a terminal window.
 Stop-Service LeeTLicensePostgreSQL17 -Force
 Test-Signing
 # Crash the actual Node child; Windows must restart it and signing must recover.
 $backend=Get-CimInstance Win32_Service -Filter "Name='LeeTLicenseCenter'"
 $child=Get-CimInstance Win32_Process | Where-Object {$_.ParentProcessId -eq $backend.ProcessId -and $_.Name -eq 'node.exe'}
 if(@($child).Count -ne 1){throw 'Could not identify dedicated issuer backend.'}
 Stop-Process -Id $child.ProcessId -Force
 $recovered=$false
 for($attempt=0;$attempt -lt 100;$attempt++){
  Start-Sleep -Milliseconds 250
  $current=Get-CimInstance Win32_Service -Filter "Name='LeeTLicenseCenter'"
  if($current.State -eq 'Running' -and $current.ProcessId -ne $backend.ProcessId){$recovered=$true;break}
 }
 if(-not $recovered){throw 'Windows did not recover the crashed issuer service.'}
 Test-Signing
 # An upgrade must preserve private keys, credentials and the existing customer ledger.
 Install-Issuer
 if((Get-FileHash (Join-Path $root 'issuer.key')).Hash -ne $keyHash -or (Get-FileHash (Join-Path $root 'management.private.json')).Hash -ne $configHash){throw 'Repair replaced issuer identity.'}
 Test-Signing
 Uninstall-Issuer $false
 if(-not (Test-Path (Join-Path $root 'issuer.key'))){throw 'Keep-data uninstall lost the signing key.'}
 if((Get-Service LeeTLicenseCenter,LeeTLicensePostgreSQL17 -ErrorAction SilentlyContinue)){throw 'Uninstall retained issuer services.'}
 Install-Issuer
 if((Get-FileHash (Join-Path $root 'issuer.key')).Hash -ne $keyHash){throw 'Reinstall replaced issuer identity.'}
 Test-Signing
 # No test ever removes another product's service or data.
 Uninstall-Issuer $true
 if((Test-Path $root) -or (Get-Service LeeTLicenseCenter,LeeTLicensePostgreSQL17 -ErrorAction SilentlyContinue)){throw 'Full uninstall retained issuer data or services.'}
 Write-Output 'PASS: standalone installer, TLS login, wrong-password rejection, paid signing, independent signature, cold service start, crash recovery, repair, preserved-data reinstall and full removal.'
}catch{
 # These logs contain setup status and generic backend error stages, never private configuration.
 $installLog=Join-Path $install 'license-center-install.log'
 if(Test-Path -LiteralPath $installLog){Get-Content -LiteralPath $installLog | Write-Output}
 $serviceLog=Join-Path $root 'license-center-service.log'
 if(Test-Path -LiteralPath $serviceLog){Get-Content -LiteralPath $serviceLog -Tail 80 | Write-Output}
 Get-ChildItem -LiteralPath $fixture -Filter 'setup-*.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | ForEach-Object {Get-Content -LiteralPath $_.FullName -Tail 100 | Write-Output}
 throw
}finally{
 if(Test-Path (Join-Path $install 'unins000.exe')){Uninstall-Issuer $true}
 if(Test-Path $fixture){Remove-Item $fixture -Recurse -Force}
}
