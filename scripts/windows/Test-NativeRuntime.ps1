$ErrorActionPreference='Stop'
$pgRoot=Join-Path $env:ProgramFiles 'PostgreSQL\17\bin'
if(-not (Test-Path (Join-Path $pgRoot 'pg_ctl.exe'))){throw 'PostgreSQL 17 binaries are required for this native Windows runtime test.'}
$root=Join-Path $env:RUNNER_TEMP ('Warehouse PostgreSQL '+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$password=[guid]::NewGuid().ToString('N')
$passwordFile=Join-Path $root 'init.private'
[IO.File]::WriteAllText($passwordFile,$password,[Text.UTF8Encoding]::new($false))
$cluster=Join-Path $root 'cluster'
try {
    & (Join-Path $pgRoot 'initdb.exe') '-D' $cluster '-U' 'postgres' '-A' 'scram-sha-256' '--pwfile' $passwordFile '--encoding=UTF8' '--locale=C'
    if($LASTEXITCODE -ne 0){throw 'Dedicated test cluster initialization failed.'}
    Remove-Item $passwordFile
    & (Join-Path $pgRoot 'pg_ctl.exe') '-D' $cluster '-l' (Join-Path $root 'postgres.log') '-o' '-h 127.0.0.1 -p 55432' '-w' 'start'
    if($LASTEXITCODE -ne 0){throw 'Dedicated PostgreSQL 17 did not start.'}
    $env:PGHOST='127.0.0.1';$env:PGPORT='55432';$env:PGUSER='postgres';$env:PGPASSWORD=$password;$env:PGDATABASE='warehouse_test';$env:WAREHOUSE_NATIVE_PG='1'
    & (Join-Path $pgRoot 'createdb.exe') 'warehouse_test'
    if($LASTEXITCODE -ne 0){throw 'Dedicated runtime test database creation failed.'}
    & node scripts/test-native-runtime.mjs
    if($LASTEXITCODE -ne 0){throw 'Windows application process runtime regression failed.'}
} finally {
    if(Test-Path $cluster){& (Join-Path $pgRoot 'pg_ctl.exe') '-D' $cluster '-m' 'fast' '-w' 'stop' | Out-Null}
    Remove-Item Env:PGPASSWORD,Env:WAREHOUSE_NATIVE_PG -ErrorAction SilentlyContinue
    Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}

& (Join-Path $PSScriptRoot 'Test-CommercialPostgres.ps1')
