[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference='Stop'
$sign=Join-Path $PSScriptRoot 'Sign-WindowsPublisherFile.ps1'
$record=& $sign -Path $Path
$file=Get-Item -LiteralPath $Path
$cache=$env:LEE_T_SIGN_UNINSTALLER_CACHE
$proof=$env:LEE_T_SIGN_UNINSTALLER_PROOF
if($cache -and $proof -and $file.DirectoryName.Equals([IO.Path]::GetFullPath($cache),[StringComparison]::OrdinalIgnoreCase) -and
   $file.Name -match '^uninst.*\.e(?:32|64)(?:\.tmp)?$'){
 # Inno removes its automatically signed temporary uninstaller after compilation.
 # Retain its exact verified bytes privately until the builder's independent check.
 $copy=Join-Path $proof ('uninstaller-'+[guid]::NewGuid().ToString('N')+'.exe')
 Copy-Item -LiteralPath $file.FullName -Destination $copy
 $verified=& $sign -Path $copy -VerifyOnly
 if($verified.Sha256 -cne $record.Sha256){throw 'The signed uninstaller proof does not match the compiler input.'}
}
$record
