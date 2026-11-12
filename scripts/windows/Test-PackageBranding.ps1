[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$SetupExecutable,
 [Parameter(Mandatory=$true)][string]$ProductName,
 [Parameter(Mandatory=$true)][version]$ExpectedVersion
)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$info=[Diagnostics.FileVersionInfo]::GetVersionInfo((Resolve-Path -LiteralPath $SetupExecutable).Path)
$binaryVersion=[version]::new($info.FileMajorPart,$info.FileMinorPart,$info.FileBuildPart,$info.FilePrivatePart)
if($binaryVersion -ne $ExpectedVersion -or $info.ProductVersion.Trim() -ne $ExpectedVersion.ToString(3) -or
 $info.ProductName.Trim() -ne $ProductName -or $info.CompanyName.Trim() -ne 'LEE T' -or
 $info.FileDescription.Trim() -ne ($ProductName+' Installer') -or
 $info.OriginalFilename.Trim() -ne (Split-Path $SetupExecutable -Leaf)){
 throw 'The finished installer has incorrect LEE T publisher, name, file version or product metadata.'
}
Add-Type -AssemblyName System.Drawing
$actual=[Drawing.Icon]::ExtractAssociatedIcon($SetupExecutable)
if($null -eq $actual){throw 'The finished installer has no shell icon.'}
$expected=[Drawing.Icon]::new((Join-Path $root 'public\brand\lee-t.ico'),$actual.Size)
$a=$actual.ToBitmap();$b=$expected.ToBitmap()
try{
 if($a.Size -ne $b.Size){throw 'Installer icon dimensions do not match the LEE T source.'}
 for($x=0;$x -lt $a.Width;$x++){for($y=0;$y -lt $a.Height;$y++){
  if($a.GetPixel($x,$y).ToArgb() -ne $b.GetPixel($x,$y).ToArgb()){throw 'Installer shell icon does not match the LEE T source pixel for pixel.'}
 }}
}finally{$a.Dispose();$b.Dispose();$actual.Dispose();$expected.Dispose()}
Write-Output ('PASS: finished '+$ProductName+' installer, exact LEE T shell icon, publisher and version '+$ExpectedVersion)
Write-Output ('Authenticode status: '+(Get-AuthenticodeSignature -LiteralPath $SetupExecutable).Status)
