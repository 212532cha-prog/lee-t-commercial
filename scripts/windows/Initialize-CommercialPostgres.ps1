#Requires -RunAsAdministrator
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$PostgresDirectory,
 [Parameter(Mandatory=$true)][string]$ClusterRoot,
 [ValidatePattern('^LeeTPostgreSQL17(?:-[a-f0-9]{8})?$')][string]$ServiceName='LeeTPostgreSQL17',
 [ValidateRange(1024,65535)][int]$Port=55433
)
$ErrorActionPreference='Stop'
if(-not [IO.Path]::IsPathRooted($ClusterRoot)){throw 'Use an absolute cluster directory.'}
$root=[IO.Path]::GetFullPath($ClusterRoot)
if(Test-Path -LiteralPath $root){throw 'Choose a new cluster directory. Existing database data will not be changed.'}
if(Get-Service -Name $ServiceName -ErrorAction SilentlyContinue){throw 'The commercial PostgreSQL service already exists.'}
if(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue){throw 'The commercial PostgreSQL port is already in use.'}

$bin=Join-Path (Resolve-Path -LiteralPath $PostgresDirectory).Path 'bin'
$postgres=Join-Path $bin 'postgres.exe'
$initdb=Join-Path $bin 'initdb.exe'
$control=Join-Path $bin 'pg_ctl.exe'
$psql=Join-Path $bin 'psql.exe'
foreach($file in @($postgres,$initdb,$control,$psql)){
 if(-not (Test-Path -LiteralPath $file -PathType Leaf)){throw 'The bundled PostgreSQL runtime is incomplete.'}
}
$version=& $postgres --version
if($LASTEXITCODE -ne 0 -or $version -notmatch '^postgres \(PostgreSQL\) 17\.'){throw 'Bundled PostgreSQL 17 is required.'}

function New-HexSecret {
 $bytes=New-Object byte[] 32
 $generator=[Security.Cryptography.RandomNumberGenerator]::Create()
 try{$generator.GetBytes($bytes);return [BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant()}finally{$generator.Dispose()}
}
function Invoke-LocalSql([string]$User,[string]$Database,[string]$Secret,[string]$Sql){
 $saved=$env:PGPASSWORD
 try{
  $env:PGPASSWORD=$Secret
  $result=$Sql | & $psql -X -q -A -t -w -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $Port -U $User -d $Database 2>$null
  if($LASTEXITCODE -ne 0){throw 'PostgreSQL setup SQL failed.'}
  return $result
 }finally{$env:PGPASSWORD=$saved}
}

$owned=$false
$registered=$false
$cluster=Join-Path $root 'cluster'
$secretFile=Join-Path $root 'init.private'
$encoding=[Text.UTF8Encoding]::new($false)
$adminSecret=New-HexSecret
$appSecret=New-HexSecret
try{
 New-Item -ItemType Directory -Path $root | Out-Null
 $owned=$true
 & icacls.exe $root '/inheritance:r' '/grant:r' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Cannot protect the PostgreSQL cluster directory.'}
 [IO.File]::WriteAllText($secretFile,$adminSecret+[Environment]::NewLine,$encoding)
 try{
  & $initdb -D $cluster -U postgres -A scram-sha-256 --pwfile $secretFile --encoding=UTF8 --locale=C | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Commercial PostgreSQL initialization failed.'}
 }finally{if(Test-Path -LiteralPath $secretFile){Remove-Item -LiteralPath $secretFile -Force}}
 [IO.File]::AppendAllText((Join-Path $cluster 'postgresql.conf'),"`nlisten_addresses = '127.0.0.1'`nport = $Port`n",$encoding)
 & $control register -N $ServiceName -D $cluster -S demand -U 'NT AUTHORITY\LocalService' -w | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Commercial PostgreSQL service registration failed.'}
 $registered=$true
 Start-Service -Name $ServiceName
 $sql="CREATE ROLE leet_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$appSecret';`nCREATE DATABASE leet_warehouse OWNER leet_app;`nREVOKE CONNECT ON DATABASE leet_warehouse FROM PUBLIC;"
 Invoke-LocalSql postgres postgres $adminSecret $sql | Out-Null
 $listener=Invoke-LocalSql leet_app leet_warehouse $appSecret 'SHOW listen_addresses;'
 if($listener -ne '127.0.0.1'){throw 'Commercial PostgreSQL must listen only on loopback.'}
 # Disable the bootstrap login after setup. The application has its own database owner.
 Invoke-LocalSql postgres postgres $adminSecret 'ALTER ROLE postgres NOLOGIN;' | Out-Null
 Set-Service -Name $ServiceName -StartupType Automatic
 [pscustomobject]@{
  ServiceName=$ServiceName
  DatabaseUrl=('postgresql://leet_app:'+ $appSecret +'@127.0.0.1:'+ $Port +'/leet_warehouse')
 }
}catch{
 if($registered){
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  & $control unregister -N $ServiceName | Out-Null
  if($LASTEXITCODE -ne 0){throw 'PostgreSQL setup failed and the service could not be removed. The data directory was retained.'}
 }
 if($owned){Remove-Item -LiteralPath $root -Recurse -Force}
 throw
}finally{
 $adminSecret=$null
 $appSecret=$null
}
