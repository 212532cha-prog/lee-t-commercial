#Requires -RunAsAdministrator
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidateSet('Warehouse','LicenseCenter')][string]$Product,
 [Parameter(Mandatory=$true)][string]$PayloadDirectory,
 [string]$OfflineIssuerPublicKey,
 [string]$OfflineIssuerKeyId
)
$ErrorActionPreference='Stop'
$scriptDirectory=$PSScriptRoot
$sign=Join-Path $PSScriptRoot 'Sign-WindowsPublisherFile.ps1'
$integration={
 param($policy,$fixtureRoot)
 Write-Host 'Publisher acceptance: build and verify the actual signed product package.'
 $output=Join-Path $fixtureRoot 'ci-only-installer'
 & (Join-Path $scriptDirectory 'Build-PublisherSignedInstaller.ps1') -Product $Product -PayloadDirectory $PayloadDirectory -OutputDirectory $output @policy -OfflineIssuerPublicKey $OfflineIssuerPublicKey -OfflineIssuerKeyId $OfflineIssuerKeyId -TestSigning | Out-Host
 $filename=if($Product -eq 'Warehouse'){'LEE-T-Warehouse-Setup.exe'}else{'LEE-T-License-Center-Setup.exe'}
 & $sign -Path (Join-Path $output $filename) @policy -TestSigning -VerifyOnly | Out-Null
 if($Product -eq 'LicenseCenter'){
  & (Join-Path $scriptDirectory 'Test-LicenseCenterInstaller.ps1') -SetupExecutable (Join-Path $output $filename) -PublisherCertificateThumbprint $policy.CertificateThumbprint -PublisherSubject $policy.ExpectedSubject -TestPublisherSigning
 }
}.GetNewClosure()
& (Join-Path $PSScriptRoot 'Test-WindowsPublisherIdentity.ps1') -VerifyPackage $integration
Write-Output ('PASS: '+$Product+' signed payload, installer and uninstaller acceptance.')
