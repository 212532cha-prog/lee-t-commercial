#Requires -RunAsAdministrator
$ErrorActionPreference='Stop'
$pg=Join-Path $env:ProgramFiles 'PostgreSQL\17'
$suffix=[guid]::NewGuid().ToString('N').Substring(0,8)
$name='LeeTLicensePostgreSQL17-'+$suffix
$root=Join-Path $env:RUNNER_TEMP ('issuer-startup-'+$suffix)
$database=Join-Path $root 'postgresql'
$listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$blocker=$null;$starter=$null;$owned=$false
New-Item -ItemType Directory -Path $root | Out-Null
try{
 $listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
 $result=& (Join-Path $PSScriptRoot 'Initialize-CommercialPostgres.ps1') -LicenseCenter -PostgresDirectory $pg -ClusterRoot $database -ServiceName $name -Port $port
 $owned=$true
 Stop-Service $name
 $log=Join-Path $root 'start.log';$stderr=Join-Path $root 'start.err'
 $ready=Join-Path $root 'ready';$released=Join-Path $root 'released'
 $fixture=Join-Path $root 'block-port.mjs'
 [IO.File]::WriteAllText($fixture,@'
import net from 'node:net';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const [port,ready,log,released]=process.argv.slice(2);
const server=net.createServer(socket=>socket.destroy());
server.listen(Number(port),'127.0.0.1',()=>writeFileSync(ready,'ready'));
const deadline=setTimeout(()=>{process.exitCode=1;server.close();clearInterval(watch)},45000);
const watch=setInterval(()=>{
 if(existsSync(log)&&readFileSync(log,'utf8').includes('PostgreSQL start attempt 1 failed')){
  server.close(()=>writeFileSync(released,'released'));clearInterval(watch);clearTimeout(deadline);
 }
},25);
'@,[Text.UTF8Encoding]::new($false))
 $blocker=Start-Process (Get-Command node.exe).Source -ArgumentList @(('"'+$fixture+'"'),$port,('"'+$ready+'"'),('"'+$log+'"'),('"'+$released+'"')) -PassThru
 for($attempt=0;$attempt -lt 100 -and -not (Test-Path $ready);$attempt++){
  if($blocker.HasExited){throw 'Could not start the isolated occupied-port fixture.'};Start-Sleep -Milliseconds 50
 }
 if(-not (Test-Path $ready)){throw 'Occupied-port fixture did not become ready.'}
 $helper=Join-Path $PSScriptRoot 'Start-LicenseCenterPostgres.ps1'
 $starter=Start-Process powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$helper+'"'),'-ServiceName',$name,'-PostgresDirectory',('"'+$pg+'"'),'-ClusterDirectory',('"'+(Join-Path $database 'cluster')+'"')) -PassThru -RedirectStandardOutput $log -RedirectStandardError $stderr
 if(-not $starter.WaitForExit(90000)){$starter.Kill();throw 'Bounded issuer startup did not finish.'}
 if($starter.ExitCode -ne 0){Get-Content $log,$stderr | Write-Output;throw 'Issuer startup did not recover after the real first-start failure.'}
 if(-not (Test-Path $released) -or (Get-Content $log -Raw) -notmatch 'PostgreSQL start attempt 1 failed'){
  throw 'The regression must exercise an actual failed start before recovery.'
 }
 if((Get-Service $name).Status -ne 'Running'){throw 'The recovered service is not running.'}
 $prior=$env:PGPASSWORD
 try{
  $uri=[uri]$result.DatabaseUrl
  $parts=$uri.UserInfo.Split(':',2)
  $env:PGPASSWORD=[uri]::UnescapeDataString($parts[1])
  $query=& (Join-Path $pg 'bin\psql.exe') -X -q -A -t -w -h 127.0.0.1 -p $port -U ([uri]::UnescapeDataString($parts[0])) -d leet_issuer -c 'SELECT current_user'
  if($LASTEXITCODE -ne 0 -or $query.Trim() -ne 'leet_license_app'){throw 'Recovered PostgreSQL cannot authenticate the dedicated issuer role.'}
 }finally{$env:PGPASSWORD=$prior}
 Write-Output 'PASS: real occupied-port first-start failure, bounded recovery and authenticated issuer SQL; no authentication or ownership fallback.'
}finally{
 $listener.Stop()
 foreach($process in @($starter,$blocker)){if($process -and -not $process.HasExited){Stop-Process -Id $process.Id -Force}}
 if($owned){
  Stop-Service $name -Force -ErrorAction SilentlyContinue
  & (Join-Path $pg 'bin\pg_ctl.exe') unregister -N $name | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Could not remove the isolated issuer startup fixture.'}
 }
 if(Test-Path $root){Remove-Item $root -Recurse -Force}
}
