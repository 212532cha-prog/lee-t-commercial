[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$Path,
 [string]$CertificateThumbprint=$env:LEE_T_SIGN_CERTIFICATE,
 [string]$ExpectedSubject=$env:LEE_T_SIGN_SUBJECT,
 [ValidateSet('CurrentUser','LocalMachine')][string]$StoreLocation=$(if($env:LEE_T_SIGN_STORE){$env:LEE_T_SIGN_STORE}else{'CurrentUser'}),
 [string]$TimestampUrl=$env:LEE_T_SIGN_TIMESTAMP,
 [switch]$TestSigning=($env:LEE_T_SIGN_TEST -eq '1'),
 [switch]$SkipTimestamp,
 [switch]$VerifyOnly,
 [ValidateRange(15,300)][int]$SignToolTimeoutSeconds=120
)
$ErrorActionPreference='Stop'
if($TestSigning -and $env:GITHUB_ACTIONS -ne 'true'){throw 'Test signing is restricted to disposable CI runners.'}
if($SkipTimestamp -and -not $TestSigning){throw 'Production signatures require an RFC 3161 timestamp.'}
if($CertificateThumbprint -notmatch '^[a-fA-F0-9]{40}$' -or [string]::IsNullOrWhiteSpace($ExpectedSubject)){
 throw 'Configure the exact publisher certificate thumbprint and legal certificate subject.'
}
if(-not $SkipTimestamp -and -not $VerifyOnly){
 $uri=$null
 if(-not [uri]::TryCreate($TimestampUrl,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -notin @('http','https') -or $uri.UserInfo -or $uri.Fragment){throw 'Configure an HTTP(S) RFC 3161 timestamp service.'}
}
$file=Get-Item -LiteralPath $Path
if($file.PSIsContainer){throw 'A Windows PE file is required.'}
for($entry=$file;$null -ne $entry;$entry=$(if($entry -is [IO.FileInfo]){$entry.Directory}else{$entry.Parent})){
 if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked signing paths are not supported.'}
}
$stream=$file.OpenRead()
try{if($stream.ReadByte() -ne 77 -or $stream.ReadByte() -ne 90){throw 'A Windows PE file is required.'}}finally{$stream.Dispose()}
function Invoke-BoundedSignTool([string[]]$Arguments){
 # These arguments are switches, thumbprints, URIs and file names; embedded quotes are never valid here.
 if(@($Arguments | Where-Object {$_ -match '"' -or $_.EndsWith('\')}).Count){throw 'Unsupported SignTool argument.'}
 $start=[Diagnostics.ProcessStartInfo]::new()
 $start.FileName=$tool
 $start.Arguments=(($Arguments | ForEach-Object {'"'+$_+'"'}) -join ' ')
 $start.UseShellExecute=$false;$start.CreateNoWindow=$true
 $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 $process=[Diagnostics.Process]::new();$process.StartInfo=$start
 try{
  if(-not $process.Start()){throw 'SignTool could not start.'}
  [void]$process.Handle
  $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
  if(-not $process.WaitForExit($SignToolTimeoutSeconds*1000)){
   $process.Kill();$process.WaitForExit()
   throw 'SignTool signing or timestamp verification timed out; the original file was retained.'
  }
  $process.WaitForExit()
  $stdout.Result | Out-Host
  $stderr.Result | Out-Host
  if($process.ExitCode -ne 0){throw 'SignTool signing, timestamping or verification failed; the original file was retained.'}
 }finally{$process.Dispose()}
}
function Assert-PublisherCertificate($Certificate,[bool]$Signing){
 if(-not $Certificate -or $Certificate.Thumbprint -ne $CertificateThumbprint -or $Certificate.Subject -cne $ExpectedSubject){throw 'The file or key does not match the configured publisher identity.'}
 if(@($Certificate.Extensions | Where-Object {$_.Oid.Value -eq '2.5.29.37'} | ForEach-Object {$_.EnhancedKeyUsages} | Where-Object {$_.Value -eq '1.3.6.1.5.5.7.3.3'}).Count -eq 0){throw 'A code-signing certificate is required; TLS and license certificates are not supported.'}
 if(-not $TestSigning -and $Certificate.Subject -eq $Certificate.Issuer){throw 'Self-signed certificates cannot be used for a production publisher release.'}
 if($Signing -and (-not $Certificate.HasPrivateKey -or $Certificate.NotBefore.ToUniversalTime() -gt [DateTime]::UtcNow -or $Certificate.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow)){
  throw 'The publisher certificate must be current and have access to its signing key.'
 }
}
function Assert-PublisherSignature([string]$File){
 $signature=Get-AuthenticodeSignature -LiteralPath $File
 if($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode'){throw ('Publisher signature validation failed: '+$signature.Status)}
 Assert-PublisherCertificate $signature.SignerCertificate $false
 if(-not $SkipTimestamp -and -not $signature.TimeStamperCertificate){throw 'The publisher signature is missing its trusted timestamp.'}
 return $signature
}
if($VerifyOnly){
 $signature=Assert-PublisherSignature $file.FullName
 [pscustomobject]@{File=$file.FullName;Subject=$signature.SignerCertificate.Subject;Thumbprint=$signature.SignerCertificate.Thumbprint;Timestamped=($null -ne $signature.TimeStamperCertificate);Sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
 return
}
$certificate=Get-Item -LiteralPath ('Cert:\'+$StoreLocation+'\My\'+$CertificateThumbprint)
Assert-PublisherCertificate $certificate $true
$before=Get-AuthenticodeSignature -LiteralPath $file.FullName
if($before.Status -ne 'NotSigned'){
 if($before.Status -ne 'Valid' -or $before.SignerCertificate.Thumbprint -ne $CertificateThumbprint){throw 'Refusing to replace a foreign or invalid existing signature.'}
}
$tools=@(Get-ChildItem -Path (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin\*\x64\signtool.exe') -ErrorAction SilentlyContinue | Sort-Object FullName -Descending)
if($tools.Count -eq 0){throw 'Install the Windows SDK signing tools.'}
$tool=$tools[0].FullName
$toolSignature=Get-AuthenticodeSignature -LiteralPath $tool
if($toolSignature.Status -ne 'Valid' -or $toolSignature.SignerCertificate.Subject -notmatch '(?:^|, )O=Microsoft Corporation(?:,|$)'){throw 'A Microsoft-signed Windows SDK SignTool is required.'}
$temporary=Join-Path $file.DirectoryName ($file.Name+'.signing-'+[guid]::NewGuid().ToString('N')+'.exe')
try{
 Copy-Item -LiteralPath $file.FullName -Destination $temporary
 $arguments=@('sign','/fd','SHA256','/sha1',$CertificateThumbprint,'/s','My')
 if($StoreLocation -eq 'LocalMachine'){$arguments+='/sm'}
 if(-not $SkipTimestamp){$arguments+=@('/tr',$TimestampUrl,'/td','SHA256')}
 $arguments+=$temporary
 Invoke-BoundedSignTool -Arguments $arguments
 $verify=@('verify','/pa','/all','/v')
 if(-not $SkipTimestamp){$verify+='/tw'}
 Invoke-BoundedSignTool -Arguments ($verify+@($temporary))
 $signature=Assert-PublisherSignature $temporary
 [IO.File]::Replace($temporary,$file.FullName,$null)
 [pscustomobject]@{File=$file.FullName;Subject=$signature.SignerCertificate.Subject;Thumbprint=$signature.SignerCertificate.Thumbprint;Timestamped=($null -ne $signature.TimeStamperCertificate);Sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
}finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force}}
