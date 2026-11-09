[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Address,[Parameter(Mandatory=$true)][string]$Directory,[switch]$TrustLocally)
$ErrorActionPreference='Stop'
$ip=[Net.IPAddress]::Parse($Address)
if ($ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'Use the selected server IPv4 address.' }
New-Item -ItemType Directory -Path $Directory -Force | Out-Null
$root=New-SelfSignedCertificate -Type Custom -Subject ('CN=LEE T Warehouse CA '+[guid]::NewGuid().ToString('N').Substring(0,8)) -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -KeyUsage CertSign,CRLSign -TextExtension @('2.5.29.19={critical}{text}ca=1') -CertStoreLocation 'Cert:\LocalMachine\My' -NotAfter (Get-Date).AddYears(10)
$names='2.5.29.17={text}DNS=localhost&IPAddress=127.0.0.1'
if($Address -ne '127.0.0.1'){$names+='&IPAddress='+$Address}
$leaf=New-SelfSignedCertificate -Type Custom -Subject ('CN='+$Address) -Signer $root -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -TextExtension @('2.5.29.19={critical}{text}ca=0',$names,'2.5.29.37={text}1.3.6.1.5.5.7.3.1') -CertStoreLocation 'Cert:\LocalMachine\My' -NotAfter (Get-Date).AddDays(365)
$bytes=New-Object byte[] 32
$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$passphrase=[Convert]::ToBase64String($bytes)
$pfx=Join-Path $Directory 'server.pfx'
Export-PfxCertificate -Cert $leaf -FilePath $pfx -Password (ConvertTo-SecureString $passphrase -AsPlainText -Force) | Out-Null
$leafPath=Join-Path $Directory 'warehouse-server.cer'
Export-Certificate -Cert $leaf -FilePath $leafPath | Out-Null
$ca=Join-Path $Directory 'warehouse-root-ca.cer'
Export-Certificate -Cert $root -FilePath $ca | Out-Null
if ($TrustLocally) { Import-Certificate -FilePath $ca -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null }
# The return value is captured by the installer/test. Never display the passphrase.
return @{PfxPath=$pfx;Passphrase=$passphrase;RootCertificate=$ca;LeafCertificate=$leafPath;RootThumbprint=$root.Thumbprint;LeafThumbprint=$leaf.Thumbprint}
