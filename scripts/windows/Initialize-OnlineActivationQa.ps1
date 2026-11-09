#Requires -RunAsAdministrator
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$NodePath,
 [Parameter(Mandatory=$true)][string]$PostgresDirectory,
 [Parameter(Mandatory=$true)][string]$Address,
 [ValidateRange(1024,65535)][int]$Port=8445,
 [ValidateRange(1024,65535)][int]$DatabasePort=55437
)
$ErrorActionPreference='Stop'
$root=Join-Path $env:ProgramData 'Lee T Online Activation QA'
$node=(Resolve-Path -LiteralPath $NodePath).Path
$postgres=(Resolve-Path -LiteralPath $PostgresDirectory).Path
$app=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$ip=[Net.IPAddress]::Parse($Address)
if($ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $ip.ToString() -cne $Address){throw 'Enter a private IPv4 address on this computer.'}
$bytes=$ip.GetAddressBytes()
if(-not ($Address -eq '127.0.0.1' -or $bytes[0] -eq 10 -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or ($bytes[0] -eq 192 -and $bytes[1] -eq 168))){
 throw 'Use a private LAN IPv4 address.'
}
if($Address -ne '127.0.0.1' -and -not (Get-NetIPAddress -IPAddress $Address -AddressFamily IPv4 -ErrorAction SilentlyContinue)){
 throw 'The test address must belong to this computer.'
}
if($Port -eq $DatabasePort -or (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)){throw 'Use an available activation port.'}
if(Test-Path -LiteralPath $root){throw 'An online test issuer already exists. Use its existing configuration.'}
if(-not (Test-Path -LiteralPath (Join-Path $app 'node_modules\pg\package.json') -PathType Leaf)){throw 'Install the locked Node dependencies first.'}

$id=[guid]::NewGuid().ToString('N').Substring(0,8)
$service='LeeTPostgreSQL17-'+$id
$utf8=[Text.UTF8Encoding]::new($false)
$certificate=$null
$database=$null
$owned=$false
try{
 New-Item -ItemType Directory -Path $root | Out-Null
 $owned=$true
 & icacls.exe $root '/inheritance:r' '/grant:r' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Cannot protect the online test issuer directory.'}
 & icacls.exe $root '/setowner' '*S-1-5-32-544' | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Cannot set the online test issuer directory owner.'}
 $database=& (Join-Path $PSScriptRoot 'Initialize-CommercialPostgres.ps1') -PostgresDirectory $postgres -ClusterRoot (Join-Path $root 'postgresql') -ServiceName $service -Port $DatabasePort
 Set-Service -Name $service -StartupType Manual
 $certificate=& (Join-Path $PSScriptRoot 'New-LanCertificate.ps1') -Address $Address -Directory $root
 $caPem="-----BEGIN CERTIFICATE-----`n"+[Convert]::ToBase64String([IO.File]::ReadAllBytes($certificate.RootCertificate),[Base64FormattingOptions]::InsertLineBreaks)+"`n-----END CERTIFICATE-----`n"
 [IO.File]::WriteAllText((Join-Path $root 'activation-ca.pem'),$caPem,$utf8)
 & $node --input-type=module -e 'import {generateKeyPairSync} from ''node:crypto'';import {writeFileSync} from ''node:fs'';import {join} from ''node:path'';const {publicKey,privateKey}=generateKeyPairSync(''ed25519'');const directory=process.argv[1];writeFileSync(join(directory,''issuer-public.pem''),publicKey.export({type:''spki'',format:''pem''}),{flag:''wx''});writeFileSync(join(directory,''issuer.key''),privateKey.export({type:''pkcs8'',format:''pem''}),{flag:''wx''});' -- $root
 if($LASTEXITCODE -ne 0){throw 'Could not generate an isolated signing key.'}
 $keyId='leet-online-qa-'+$id
 $config=@{
  databaseUrl=$database.DatabaseUrl; databaseServiceName=$service; bind=$Address; port=$Port; issuerKeyId=$keyId
  tlsPfxPath=$certificate.PfxPath; tlsPfxPassphrase=$certificate.Passphrase; issuerKeyPath=(Join-Path $root 'issuer.key')
 }
 [IO.File]::WriteAllText((Join-Path $root 'service.private.json'),($config|ConvertTo-Json -Compress),$utf8)
 $profile=@{
  endpoint=('https://'+$Address+':'+$Port+'/v1/activation/redeem')
  issuerKeyId=$keyId; issuerPublicKey=[IO.File]::ReadAllText((Join-Path $root 'issuer-public.pem')); activationCa=$caPem
 }
 [IO.File]::WriteAllText((Join-Path $root 'installer-profile.json'),($profile|ConvertTo-Json -Compress),$utf8)
 Write-Output ('Online QA issuer initialized at '+$root+'. Share only installer-profile.json for packaging.')
}catch{
 if($database){
  Stop-Service -Name $service -ErrorAction SilentlyContinue
  & (Join-Path $postgres 'bin\pg_ctl.exe') unregister -N $service | Out-Null
  if($LASTEXITCODE -ne 0){throw 'The isolated database service could not be removed. Its files were retained.'}
 }
 if($owned){Remove-Item -LiteralPath $root -Recurse -Force}
 throw
}finally{
 if($certificate){
  foreach($thumbprint in @($certificate.LeafThumbprint,$certificate.RootThumbprint)){
   Remove-Item -LiteralPath ('Cert:\LocalMachine\My\'+$thumbprint) -ErrorAction SilentlyContinue
  }
 }
}
