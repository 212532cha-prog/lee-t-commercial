[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$NodeDirectory,
 [Parameter(Mandatory=$true)][string]$PostgresDirectory,
 [Parameter(Mandatory=$true)][string]$DesktopDirectory,
 [Parameter(Mandatory=$true)][string]$WebView2Installer,
 [Parameter(Mandatory=$true)][string]$ManagementDirectory,
 [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference='Stop'
if(-not [Environment]::Is64BitOperatingSystem){throw 'Build on Windows x64.'}
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$nodeRoot=(Resolve-Path -LiteralPath $NodeDirectory).Path
$postgres=(Resolve-Path -LiteralPath $PostgresDirectory).Path
$desktop=(Resolve-Path -LiteralPath $DesktopDirectory).Path
$management=(Resolve-Path -LiteralPath $ManagementDirectory).Path
$webView=(Resolve-Path -LiteralPath $WebView2Installer).Path
if(-not (Test-Path -LiteralPath (Join-Path $desktop 'LeeT.Warehouse.exe') -PathType Leaf)){throw 'Build the Windows desktop client first.'}
$signature=Get-AuthenticodeSignature -LiteralPath $webView
if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|, )O=Microsoft Corporation(?:,|$)'){
 throw 'The bundled WebView2 installer must have a valid Microsoft signature.'
}
$output=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $output){throw 'Choose a new output directory.'}
$node=Join-Path $nodeRoot 'node.exe'
$npm=Join-Path $nodeRoot 'npm.cmd'
$server=Join-Path $postgres 'bin\postgres.exe'
foreach($path in @($node,$npm,$server,(Join-Path $postgres 'bin\initdb.exe'),(Join-Path $postgres 'bin\pg_ctl.exe'),(Join-Path $postgres 'bin\psql.exe'))){
 if(-not (Test-Path -LiteralPath $path -PathType Leaf)){throw 'A required vendor runtime file is missing.'}
}
$nodeVersion=& $node -p "process.platform+':'+process.arch+':'+process.versions.node"
if($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^win32:x64:24\.'){throw 'The installer payload requires Windows x64 Node.js 24.'}
& $node (Join-Path $root 'scripts\verify-ruoyi-bundle.mjs') verify $management
if($LASTEXITCODE -ne 0){throw 'The management bundle failed validation.'}
$pgVersion=& $server --version
if($LASTEXITCODE -ne 0 -or $pgVersion -notmatch '^postgres \(PostgreSQL\) 17\.'){throw 'The installer payload requires PostgreSQL 17.'}
$pgDirectories=@('bin','lib','share')
foreach($name in $pgDirectories){
 if(-not (Test-Path -LiteralPath (Join-Path $postgres $name) -PathType Container)){throw 'The PostgreSQL binary distribution is incomplete.'}
}
$temporary=$output+'.staging-'+[guid]::NewGuid().ToString('N')
$previousPath=$env:Path
try{
 $app=Join-Path $temporary 'app'
 $runtime=Join-Path $temporary 'runtime'
 $pgTarget=Join-Path $runtime 'postgresql'
 New-Item -ItemType Directory -Path $app,$pgTarget -Force | Out-Null
 & git -C $root diff --cached --quiet HEAD
 if($LASTEXITCODE -ne 0){throw 'Stage from a clean Git index matching HEAD.'}
 $prefix=$app.Replace('\','/')+'/'
 & git -C $root checkout-index --all "--prefix=$prefix"
 if($LASTEXITCODE -ne 0){throw 'Cannot export tracked source.'}
 Copy-Item -LiteralPath $management -Destination (Join-Path $app 'management') -Recurse
 & $node (Join-Path $app 'scripts\verify-ruoyi-bundle.mjs') verify (Join-Path $app 'management')
 if($LASTEXITCODE -ne 0){throw 'The staged management bundle failed validation.'}
 Copy-Item -LiteralPath $desktop -Destination (Join-Path $temporary 'desktop') -Recurse
 Copy-Item -LiteralPath $webView -Destination (Join-Path $runtime 'WebView2RuntimeInstaller.exe')
 Copy-Item -LiteralPath $node -Destination (Join-Path $runtime 'node.exe')
 foreach($name in $pgDirectories){Copy-Item -LiteralPath (Join-Path $postgres $name) -Destination $pgTarget -Recurse}
 $env:Path=$nodeRoot+';'+$previousPath
 Push-Location $app
 try{
  & $npm ci --omit=dev --ignore-scripts
  if($LASTEXITCODE -ne 0){throw 'Cannot stage production dependencies.'}
  & (Join-Path $runtime 'node.exe') --input-type=module -e "await import('pg'); await import('sharp'); await import('@node-rs/argon2');"
  if($LASTEXITCODE -ne 0){throw 'Staged runtime dependencies failed to load.'}
 }finally{Pop-Location}
 & (Join-Path $PSScriptRoot 'Build-Service.ps1') -OutputPath (Join-Path $app 'WarehouseService.exe')
 [IO.Directory]::Move($temporary,$output)
 Write-Output ('Commercial installer payload staged at '+$output)
}finally{
 $env:Path=$previousPath
 if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Recurse -Force}
}
