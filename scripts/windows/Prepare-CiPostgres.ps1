# CI-only vendor-runtime provisioning; production installers do not call this.
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true'){throw 'Run this helper only on an isolated GitHub Actions runner.'}
$server=Join-Path $env:ProgramFiles 'PostgreSQL\17\bin\postgres.exe'
if(-not (Test-Path -LiteralPath $server -PathType Leaf)){
 $password=[guid]::NewGuid().ToString('N')
 & choco install postgresql17 --version=17.11.0 -y --no-progress --params "/Password:$password /Port:55439 /NoPath" --ia '--enable-components server,commandlinetools'
 if($LASTEXITCODE -notin @(0,3010)){throw 'Cannot provision PostgreSQL 17 for the Windows acceptance gate.'}
}
$version=& $server --version
if($LASTEXITCODE -ne 0 -or $version -notmatch '^postgres \(PostgreSQL\) 17\.'){
 throw 'Windows acceptance still requires native PostgreSQL 17.'
}
Write-Output $version
