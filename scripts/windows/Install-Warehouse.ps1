#Requires -RunAsAdministrator
[CmdletBinding()]
param([string]$AppRoot=([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))),[string]$DataDir,[string]$BackupPath1,[string]$BackupPath2,[string]$Address,[int]$Port=3443,[string]$PostgresService,[switch]$NoStart,[string]$BundledNodePath,[switch]$OfflineDependencies,[switch]$Commercial,[string]$LicenseDir,[string]$IssuerPublicKeyPath,[string]$IssuerKeyId)
$ErrorActionPreference='Stop'
function Read-PlainSecret([string]$Prompt) { $secure=Read-Host $Prompt -AsSecureString;$pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);try{return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)} }
function Protect-Directory([string]$Path,[string]$ServiceAccess) { New-Item -ItemType Directory -Path $Path -Force | Out-Null;& icacls.exe $Path '/inheritance:r' '/grant:r' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' ('*S-1-5-19:(OI)(CI)'+$ServiceAccess) '/C' | Out-Null;if($LASTEXITCODE -ne 0){throw 'Cannot apply required NTFS permissions.'} }
$serviceName = if($Commercial){'LeeTCommercialWarehouse'}else{'TatLeeWarehouse'}
$displayName = if($Commercial){'Lee T Commercial Warehouse'}else{'TAT LEE Warehouse'}
if(Get-Service $serviceName -ErrorAction SilentlyContinue){throw 'Service already exists. Use the update/migration instructions; reinstall never resets a database.'}
if(-not $DataDir){$DataDir=Read-Host 'Absolute data directory (at least 2 GB free, outside application folder)'}
if(([bool]$BackupPath1) -ne ([bool]$BackupPath2)){throw 'Provide both automatic backup paths or omit both.'}
if(-not $Address){$Address=Read-Host 'Fixed/reserved LAN IPv4 address of this computer'}
foreach($path in (@($AppRoot,$DataDir,$BackupPath1,$BackupPath2) | Where-Object { $_ })){if(-not [IO.Path]::IsPathRooted($path)){throw 'Use absolute paths.'}}
$AppRoot=[IO.Path]::GetFullPath($AppRoot);$DataDir=[IO.Path]::GetFullPath($DataDir)
if((Test-Path $DataDir) -and @(Get-ChildItem $DataDir -Force).Count -gt 0){throw 'First installation requires an empty dedicated data directory. Existing data must use the update/restore procedure.'}
if(([IO.DriveInfo]::new([IO.Path]::GetPathRoot($DataDir))).DriveFormat -ne 'NTFS'){throw 'The protected data directory requires an NTFS volume.'}
if($BackupPath1){
$BackupPath1=[IO.Path]::GetFullPath($BackupPath1);$BackupPath2=[IO.Path]::GetFullPath($BackupPath2)
if($BackupPath1 -eq $BackupPath2){throw 'Choose two different dedicated backup directories.'}
foreach($backupPath in @($BackupPath1,$BackupPath2)){if($backupPath.TrimEnd('\') -eq [IO.Path]::GetPathRoot($backupPath).TrimEnd('\') -or $backupPath -eq $DataDir -or $backupPath.StartsWith($DataDir.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or $backupPath -eq $AppRoot -or $backupPath.StartsWith($AppRoot.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Use dedicated backup subdirectories outside the application and data directory.'}}
}
if($DataDir.StartsWith($AppRoot.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or $DataDir -eq $AppRoot){throw 'Data must stay outside the application directory.'}
if(([IO.DriveInfo]::new([IO.Path]::GetPathRoot($DataDir))).AvailableFreeSpace -lt 2GB){throw 'Data drive needs at least 2 GB free before installation.'}
if(([IO.DriveInfo]::new([IO.Path]::GetPathRoot($AppRoot))).AvailableFreeSpace -lt 1GB){throw 'Application drive needs at least 1 GB free. Select another drive if C: is full.'}
$adapter=Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -eq $Address | Select-Object -First 1
if(-not $adapter){throw 'Address does not belong to this computer.'}
$network=Get-NetConnectionProfile -InterfaceIndex $adapter.InterfaceIndex
if($network.NetworkCategory -ne 'Private'){throw 'Set only the trusted warehouse network to Private before installing.'}
if($Port -lt 1024 -or $Port -gt 65535){throw 'Choose a port between 1024 and 65535.'}
if(-not $PostgresService){$services=@(Get-Service 'postgresql*' -ErrorAction SilentlyContinue);if($services.Count -ne 1){throw 'Specify the dedicated PostgreSQL 17 service using -PostgresService.'};$PostgresService=$services[0].Name}
if(-not (Get-Service $PostgresService -ErrorAction SilentlyContinue)){throw 'PostgreSQL service was not found.'}
if($BundledNodePath){
 if(-not [IO.Path]::IsPathRooted($BundledNodePath) -or -not (Test-Path -LiteralPath $BundledNodePath -PathType Leaf)){throw 'Bundled Node executable was not found.'}
 $node=[IO.Path]::GetFullPath($BundledNodePath)
}else{$node=(Get-Command node.exe).Source}
if($OfflineDependencies -and -not (Test-Path -LiteralPath (Join-Path $AppRoot 'node_modules\pg\package.json') -PathType Leaf)){throw 'Bundled production dependencies were not found.'}
if($Commercial){
 foreach($path in @($LicenseDir,$IssuerPublicKeyPath)){if(-not $path -or -not [IO.Path]::IsPathRooted($path)){throw 'Absolute license and issuer key paths are required.'}}
 if(-not $IssuerKeyId -or -not (Test-Path -LiteralPath $IssuerPublicKeyPath -PathType Leaf)){throw 'Issuer trust configuration is required.'}
 $verify=[Diagnostics.ProcessStartInfo]::new($node,'"' + (Join-Path $AppRoot 'scripts\lee-t-license.mjs') + '" verify')
 $verify.UseShellExecute=$false
 $verify.EnvironmentVariables['LEE_T_LICENSE_DIR']=$LicenseDir
 $verify.EnvironmentVariables['LEE_T_ISSUER_PUBLIC_KEY_PATH']=$IssuerPublicKeyPath
 $verify.EnvironmentVariables['LEE_T_ISSUER_KEY_ID']=$IssuerKeyId
 $verifier=[Diagnostics.Process]::Start($verify)
 try{$verifier.WaitForExit();if($verifier.ExitCode -ne 0){throw 'Commercial activation must be completed before service installation.'}}finally{$verifier.Dispose()}
}
$nodeVersion=[version]((& $node -p 'process.versions.node').Trim())
if(-not (($nodeVersion.Major -eq 22 -and $nodeVersion.Minor -ge 17) -or $nodeVersion.Major -ge 24)){throw 'Install Node.js 24 LTS (or supported Node 22) first.'}
Protect-Directory $DataDir 'M'
$configPath=Join-Path $DataDir 'service.private.json'
if(Test-Path $configPath){throw 'Protected configuration already exists. Do not overwrite existing installation data.'}
if(-not $OfflineDependencies){
 $npm=(Get-Command npm.cmd).Source
 Push-Location $AppRoot
 try{& $npm ci --omit=dev --ignore-scripts;if($LASTEXITCODE -ne 0){throw 'Dependency installation failed.'}}finally{Pop-Location}
}
foreach($backupPath in (@($BackupPath1,$BackupPath2) | Where-Object { $_ })){New-Item -ItemType Directory -Path $backupPath -Force | Out-Null;& icacls.exe $backupPath '/grant:r' '*S-1-5-19:(OI)(CI)M' | Out-Null;if($LASTEXITCODE -ne 0){throw 'Cannot grant backup directory access to LocalService.'}}
$databaseUrl=Read-PlainSecret 'Dedicated local PostgreSQL connection URL (not the database administrator account)'
$initial=Read-PlainSecret 'Initial CTL LEE password (use the agreed initial password)'
$certificate=& (Join-Path $PSScriptRoot 'New-LanCertificate.ps1') -Address $Address -Directory (Join-Path $DataDir 'tls') -TrustLocally
$origin='https://'+$Address+':'+$Port
$config=@{ServiceName=$serviceName;AppRoot=$AppRoot;NodePath=$node;Environment=@{DATABASE_URL=$databaseUrl;PUBLIC_ORIGIN=$origin;DATA_DIR=$DataDir;APP_PORT=[string]$Port;APP_BIND='0.0.0.0';TLS_PFX_PATH=$certificate.PfxPath;TLS_PFX_PASSPHRASE=$certificate.Passphrase}}
if($Commercial){
 $config.EntryScript='scripts/start-commercial.mjs'
 $config.Environment.LEE_T_LICENSE_DIR=$LicenseDir
 $config.Environment.LEE_T_ISSUER_PUBLIC_KEY_PATH=$IssuerPublicKeyPath
 $config.Environment.LEE_T_ISSUER_KEY_ID=$IssuerKeyId
}
[IO.File]::WriteAllText($configPath,($config|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
$executable=Join-Path $AppRoot 'WarehouseService.exe'
& (Join-Path $PSScriptRoot 'Build-Service.ps1') -OutputPath $executable
$start=[Diagnostics.ProcessStartInfo]::new($node,'"'+(Join-Path $AppRoot 'scripts\initialize-server.mjs')+'" --require-local-listener')
$start.WorkingDirectory=$AppRoot;$start.UseShellExecute=$false;$start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true;$start.EnvironmentVariables['WAREHOUSE_CONFIG_PATH']=$configPath
$process=[Diagnostics.Process]::new();$process.StartInfo=$start
try{[void]$process.Start();$process.StandardInput.WriteLine((@{initialPassword=$initial;backupPath1=$BackupPath1;backupPath2=$BackupPath2}|ConvertTo-Json -Compress));$process.StandardInput.Close();$output=$process.StandardOutput.ReadToEnd();$errors=$process.StandardError.ReadToEnd();$process.WaitForExit();if($process.ExitCode -ne 0){throw 'Database initialization failed. Check the dedicated database role, PostgreSQL 17 and loopback-only listener. Protected configuration was preserved for diagnosis.'};Write-Output $output.Trim()}finally{$initial=$null;$databaseUrl=$null;$process.Dispose()}
Protect-Directory $AppRoot 'RX'
$credential=[Management.Automation.PSCredential]::new('NT AUTHORITY\LocalService',[Security.SecureString]::new())
New-Service -Name $serviceName -DisplayName $displayName -BinaryPathName ('"'+$executable+'" "'+$configPath+'"') -StartupType Automatic -DependsOn $PostgresService -Credential $credential | Out-Null
& sc.exe failure $serviceName reset= 86400 actions= 'restart/5000/restart/15000/none/0' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Service recovery configuration failed.'}
New-NetFirewallRule -DisplayName ($displayName+' LAN HTTPS') -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Program $node -Profile Private -InterfaceAlias $adapter.InterfaceAlias -RemoteAddress LocalSubnet | Out-Null
if(-not $NoStart){Start-Service $serviceName}
Write-Output ('Installed service. LAN address: '+$origin)
Write-Output ('Install and trust this public root certificate on each phone: '+$certificate.RootCertificate)
Write-Output 'Phone/HID, actual shutdown/reboot, external storage and new-computer restore still require the acceptance checklist. Do not open router/public ports.'
