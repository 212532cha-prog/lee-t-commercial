#Requires -RunAsAdministrator
$ErrorActionPreference='Stop'
$root=Join-Path $env:RUNNER_TEMP ('leet-removal-'+[guid]::NewGuid().ToString('N'))
$payload=Join-Path $root 'program'
$data=Join-Path $root 'data'
$warehouse='LeeTRemovalApp'+[guid]::NewGuid().ToString('N')
$database='LeeTRemovalDB'+[guid]::NewGuid().ToString('N')
$dependent='LeeTRemovalDependent'+[guid]::NewGuid().ToString('N')
$script=Join-Path $PSScriptRoot 'Remove-CommercialInstallation.ps1'
New-Item -ItemType Directory -Path $payload,$data | Out-Null
$record=Join-Path $payload 'commercial-install.json'
$activation=Join-Path $root 'Lee T Offline Activation'
$identity=[guid]::NewGuid().ToString()
$cache=Join-Path $env:LOCALAPPDATA 'LEE T\Warehouse Desktop'
if(Test-Path -LiteralPath $cache){throw 'Use a clean Windows test user for desktop-cache removal acceptance.'}
New-Item -ItemType Directory -Path $activation,$cache | Out-Null
[IO.File]::WriteAllText((Join-Path $activation 'installation-id'),$identity)
[IO.File]::WriteAllText((Join-Path $cache 'test-session.txt'),'isolated fixture session')
$marker=Join-Path $data 'keep-me.txt'
[IO.File]::WriteAllText($record,(@{Schema=2;PayloadDirectory=$payload;DataRoot=$data;LicenseDirectory=$activation;InstallationId=$identity}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($marker,'warehouse fixture')
$tls=Join-Path $data 'data\tls'
$certificates=& (Join-Path $PSScriptRoot 'New-LanCertificate.ps1') -Address '127.0.0.1' -Directory $tls -TrustLocally
$caThumbprint=$certificates.RootThumbprint
$leafThumbprint=$certificates.LeafThumbprint
$arguments=@{PayloadDirectory=$payload;WarehouseServiceName=$warehouse;DatabaseServiceName=$database}
try{
 # SCM registrations exercise ownership checks without launching fixture programs.
 foreach($name in @($warehouse,$database)){
  & sc.exe create $name binPath= ('"'+$payload+'\fixture.exe" -D "'+$data+'\cluster"') | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Could not create isolated removal service.'}
 }
 & $script @arguments -CheckOnly
 & sc.exe create $dependent binPath= ('"'+$payload+'\shared.exe"') | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Could not create isolated dependent service.'}
 $rejected=$false
 try{& $script @arguments -RemoveData}catch{if($_.Exception.Message -notlike '*Another service uses*'){throw};$rejected=$true}
 if(-not $rejected -or -not (Test-Path -LiteralPath $marker) -or -not (Get-Service -Name $warehouse -ErrorAction SilentlyContinue)){
  throw 'Dependent runtime was not protected before removal.'
 }
 & sc.exe delete $dependent | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Could not remove isolated dependent service.'}
 & $script @arguments
 if(-not (Test-Path -LiteralPath $marker) -or -not (Test-Path -LiteralPath $activation) -or -not (Test-Path -LiteralPath $cache)){
  throw 'Default removal erased data, activation or a desktop session.'
 }
 foreach($name in @($warehouse,$database)){
  if(Get-Service -Name $name -ErrorAction SilentlyContinue){throw 'Owned service registration remains.'}
 }
 [IO.File]::WriteAllText((Join-Path $activation 'installation-id'),[guid]::NewGuid().ToString())
 $rejected=$false
 try{& $script @arguments -RemoveData}catch{if($_.Exception.Message -notlike '*Activation belongs to another*'){throw};$rejected=$true}
 if(-not $rejected -or -not (Test-Path -LiteralPath $marker) -or -not (Test-Path -LiteralPath $cache)){
  throw 'A mismatched activation identity allowed destructive removal.'
 }
 [IO.File]::WriteAllText((Join-Path $activation 'installation-id'),$identity)
 & $script @arguments -RemoveData
 if((Test-Path -LiteralPath ('Cert:\LocalMachine\Root\'+$caThumbprint)) -or
    (Test-Path -LiteralPath ('Cert:\LocalMachine\My\'+$caThumbprint)) -or
    (Test-Path -LiteralPath ('Cert:\LocalMachine\My\'+$leafThumbprint))){throw 'Full removal left warehouse TLS certificates.'}
 if((Test-Path -LiteralPath $activation) -or (Test-Path -LiteralPath $cache)){throw 'Full removal left activation or desktop login cache.'}
 if(Test-Path -LiteralPath $data){throw 'Explicit data removal left the warehouse directory.'}
 $outside=Join-Path $root 'other-install'
 New-Item -ItemType Directory -Path $outside | Out-Null
 & sc.exe create $warehouse binPath= ('"'+$outside+'\fixture.exe" -D "'+$outside+'\cluster"') | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Could not create foreign-install fixture.'}
 $rejected=$false
 try{& $script @arguments}catch{if($_.Exception.Message -notlike '*another installation*'){throw};$rejected=$true}
 if(-not $rejected -or -not (Get-Service -Name $warehouse -ErrorAction SilentlyContinue)){throw 'Foreign warehouse service was removed.'}
 Write-Output 'Commercial removal ownership, dependency protection, data retention and explicit cleanup passed.'
}finally{
 foreach($name in @($warehouse,$database,$dependent)){
  if(Get-Service -Name $name -ErrorAction SilentlyContinue){& sc.exe delete $name | Out-Null}
 }
 foreach($certificatePath in @(('Cert:\LocalMachine\Root\'+$caThumbprint),('Cert:\LocalMachine\My\'+$caThumbprint),('Cert:\LocalMachine\My\'+$leafThumbprint))){
  if(Test-Path -LiteralPath $certificatePath){Remove-Item -LiteralPath $certificatePath -Force -ErrorAction SilentlyContinue}
 }
 Remove-Item -LiteralPath $cache -Recurse -Force -ErrorAction SilentlyContinue
 Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
