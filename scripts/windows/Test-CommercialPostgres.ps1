#Requires -RunAsAdministrator
$ErrorActionPreference='Stop'
$pgRoot=Join-Path $env:ProgramFiles 'PostgreSQL\17'
$control=Join-Path $pgRoot 'bin\pg_ctl.exe'
$suffix=[guid]::NewGuid().ToString('N').Substring(0,8)
$name='LeeTPostgreSQL17-'+$suffix
$root=Join-Path $env:RUNNER_TEMP ('Lee T commercial '+$suffix)
$bootstrap=Join-Path $PSScriptRoot 'Initialize-CommercialPostgres.ps1'
$listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$previous=$env:LEET_TEST_DATABASE_URL
$owned=$false
try{
 $listener.Start()
 $port=([Net.IPEndPoint]$listener.LocalEndpoint).Port
 $blocked=$false
 try{& $bootstrap -PostgresDirectory $pgRoot -ClusterRoot $root -ServiceName $name -Port $port | Out-Null}
 catch{if($_.Exception.Message -notmatch 'port is already in use'){throw};$blocked=$true}
 if(-not $blocked -or (Test-Path -LiteralPath $root) -or (Get-Service $name -ErrorAction SilentlyContinue)){throw 'An occupied port must stop setup before creating anything.'}
 $listener.Stop()
 $result=& $bootstrap -PostgresDirectory $pgRoot -ClusterRoot $root -ServiceName $name -Port $port
 $owned=$true
 if($result.ServiceName -ne $name -or (Test-Path (Join-Path $root 'init.private'))){throw 'Commercial PostgreSQL setup did not finalize correctly.'}
 $service=Get-CimInstance Win32_Service -Filter "Name='$name'"
 if($service.StartMode -ne 'Auto' -or $service.StartName -notmatch 'LocalService$'){throw 'Expected an automatic LocalService database service.'}
 Restart-Service $name
 $env:LEET_TEST_DATABASE_URL=$result.DatabaseUrl
 @'
import assert from 'node:assert/strict';
import { createPool, migrate } from './src/db/database.mjs';
const pool=createPool(process.env.LEET_TEST_DATABASE_URL);
try {
 await migrate(pool);
 const {rows:[row]}=await pool.query("SELECT current_user AS username, current_database() AS database, current_setting('listen_addresses') AS listener, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user");
 assert.deepEqual(row,{username:'leet_app',database:'leet_warehouse',listener:'127.0.0.1',rolsuper:false,rolcreatedb:false,rolcreaterole:false});
 assert.equal((await pool.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='postgres'")).rows[0].rolcanlogin,false);
} finally { await pool.end(); }
'@ | & node --input-type=module
 if($LASTEXITCODE -ne 0){throw 'Commercial database service runtime checks failed.'}
 Write-Output 'Commercial PostgreSQL occupied-port protection, service restart, migrations and database role checks passed.'
}finally{
 $listener.Stop()
 $env:LEET_TEST_DATABASE_URL=$previous
 if($owned){
  Stop-Service $name -Force -ErrorAction SilentlyContinue
  & $control unregister -N $name | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Could not remove the isolated test database service.'}
  Remove-Item -LiteralPath $root -Recurse -Force
 }
}
