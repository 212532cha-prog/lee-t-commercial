[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $compiler)) { throw 'The Windows .NET Framework 4.x C# compiler is required.' }
$source = Join-Path $PSScriptRoot 'WarehouseService.cs'
& $compiler '/nologo' '/target:exe' '/platform:anycpu' '/reference:System.ServiceProcess.dll' '/reference:System.Web.Extensions.dll' "/out:$OutputPath" $source
if ($LASTEXITCODE -ne 0) { throw 'Native service host compilation failed.' }
