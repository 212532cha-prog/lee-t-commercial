#Requires -RunAsAdministrator
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$PostgresDirectory,
 [Parameter(Mandatory=$true)][string]$NodePath,
 [string]$Root=(Join-Path $env:ProgramData 'Lee T License Center'),
 [string]$DatabaseServiceName='LeeTLicensePostgreSQL17',
 [ValidateRange(1024,65535)][int]$DatabasePort=55435,
 [ValidateRange(1024,65535)][int]$ManagementPort=8444,
 [securestring]$OperatorPassword
)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($Root)
$node=(Resolve-Path -LiteralPath $NodePath).Path
$app=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
if(Test-Path -LiteralPath $root){throw 'Choose a new License Center directory. Existing issuer data will not be changed.'}
if($DatabasePort -eq $ManagementPort -or (Get-NetTCPConnection -LocalPort $ManagementPort -State Listen -ErrorAction SilentlyContinue)){
 throw 'Choose an unused management port different from the database port.'
}
for($parent=[IO.DirectoryInfo]::new($root);$null -ne $parent;$parent=$parent.Parent){
 if($parent.Exists -and ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'License Center setup cannot use linked directories.'}
}
if(-not $OperatorPassword){$OperatorPassword=Read-Host 'Set the issuer password (12 to 128 characters)' -AsSecureString}
if($OperatorPassword.Length -lt 12 -or $OperatorPassword.Length -gt 128){throw 'Use an issuer password of 12 to 128 characters.'}

$owned=$false
$database=$null
$ca=$null
$server=$null
$operator=$null
$trusted=$false
$process=$null
try{
 New-Item -ItemType Directory -Path $root | Out-Null
 $owned=$true
 & icacls.exe $root '/inheritance:r' '/grant:r' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Cannot protect the issuer directory.'}
 & icacls.exe $root '/setowner' '*S-1-5-32-544' | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Cannot set the issuer directory owner.'}
 $database=& (Join-Path $PSScriptRoot 'Initialize-CommercialPostgres.ps1') -LicenseCenter -PostgresDirectory $PostgresDirectory -ClusterRoot (Join-Path $root 'postgresql') -ServiceName $DatabaseServiceName -Port $DatabasePort
 $label='LEE T License Center '+[guid]::NewGuid().ToString('N').Substring(0,8)
 $ca=New-SelfSignedCertificate -Type Custom -Subject ('CN='+$label+' CA') -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -KeyUsage CertSign,CRLSign -TextExtension @('2.5.29.19={critical}{text}ca=1') -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddYears(5)
 $server=New-SelfSignedCertificate -Type Custom -Subject 'CN=127.0.0.1' -Signer $ca -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -TextExtension @('2.5.29.19={critical}{text}ca=0','2.5.29.17={text}IPAddress=127.0.0.1','2.5.29.37={text}1.3.6.1.5.5.7.3.1') -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddYears(2)
 $operator=New-SelfSignedCertificate -Type Custom -Subject ('CN='+$label+' Issuer') -Signer $ca -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -KeyUsage DigitalSignature -TextExtension @('2.5.29.19={critical}{text}ca=0','2.5.29.37={text}1.3.6.1.5.5.7.3.2') -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddYears(2)
 $caPath=Join-Path $root 'management-ca.cer'
 Export-Certificate -Cert $ca -FilePath $caPath | Out-Null
 Export-Certificate -Cert $operator -FilePath (Join-Path $root 'operator.cer') | Out-Null
 $bytes=New-Object byte[] 32
 $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
 try{$rng.GetBytes($bytes)}finally{$rng.Dispose()}
 $pfxPassphrase=[Convert]::ToBase64String($bytes)
 Export-PfxCertificate -Cert $server -FilePath (Join-Path $root 'management.pfx') -Password (ConvertTo-SecureString $pfxPassphrase -AsPlainText -Force) | Out-Null
 $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($OperatorPassword)
 try{$plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
 $info=[Diagnostics.ProcessStartInfo]::new($node,('"' + (Join-Path $app 'scripts\initialize-local-license-management.mjs') + '"'))
 $info.WorkingDirectory=$app
 $info.UseShellExecute=$false
 $info.RedirectStandardInput=$true
 foreach($name in @('NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','NODE_TLS_REJECT_UNAUTHORIZED')){
  $info.EnvironmentVariables.Remove($name)
 }
 $process=[Diagnostics.Process]::Start($info)
 $writer=[IO.StreamWriter]::new($process.StandardInput.BaseStream,[Text.UTF8Encoding]::new($false))
 try{$writer.Write((@{root=$root;databaseUrl=$database.DatabaseUrl;port=$ManagementPort;pfxPassphrase=$pfxPassphrase;operatorPassword=$plain}|ConvertTo-Json -Compress))}
 finally{$writer.Dispose()}
 $process.WaitForExit()
 if($process.ExitCode -ne 0){throw 'Could not initialize the local issuer database and configuration.'}
 Import-Certificate -FilePath $caPath -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
 $trusted=$true
 Write-Output ('Local License Center initialized at '+$root+'.')
 Write-Output ('Start with Start-LocalLicenseCenter.ps1. Sign in as issuer using the password just configured.')
}catch{
 if($trusted){Remove-Item -LiteralPath ('Cert:\LocalMachine\Root\'+$ca.Thumbprint) -ErrorAction SilentlyContinue}
 foreach($certificate in @($operator,$server,$ca)){
  if($certificate){Remove-Item -LiteralPath ('Cert:\CurrentUser\My\'+$certificate.Thumbprint) -ErrorAction SilentlyContinue}
 }
 if($database){
  Stop-Service -Name $database.ServiceName -ErrorAction SilentlyContinue
  & (Join-Path $PostgresDirectory 'bin\pg_ctl.exe') unregister -N $database.ServiceName | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Setup failed and could not remove its database service. The data directory was retained.'}
 }
 if($owned){Remove-Item -LiteralPath $root -Recurse -Force}
 throw
}finally{
 if($process){$process.Dispose()}
 $plain=$null
 $pfxPassphrase=$null
 $database=$null
}
