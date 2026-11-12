#Requires -RunAsAdministrator
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$InstallDirectory,
 [string]$PasswordFile
)
$ErrorActionPreference='Stop'
$install=[IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
$root=Join-Path $env:ProgramData 'Lee T License Center'
$config=Join-Path $root 'management.private.json'
$pg=Join-Path $install 'runtime\postgresql'
$node=Join-Path $install 'runtime\node.exe'
$hostPath=Join-Path $install 'LeeTLicenseCenterService.exe'
$databaseService='LeeTLicensePostgreSQL17'
$backendService='LeeTLicenseCenter'
foreach($file in @($node,$hostPath,(Join-Path $pg 'bin\pg_ctl.exe'))){
 if(-not (Test-Path -LiteralPath $file -PathType Leaf)){throw 'License Center installation is incomplete.'}
}
foreach($path in @($install,$root)){
 for($parent=[IO.DirectoryInfo]::new($path);$null -ne $parent;$parent=$parent.Parent){
  if($parent.Exists -and ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Linked installation or data directories are not supported.'}
 }
}
$service=Get-CimInstance Win32_Service -Filter "Name='$backendService'"
if($service){
 $expected='"'+$hostPath+'" "'+$root+'"'
 if($service.PathName -ne $expected){throw 'Another installation owns the License Center service.'}
 Stop-Service $backendService
}
if(-not (Test-Path -LiteralPath $config)){
 $password=$null
 if($PasswordFile){
  $password=ConvertTo-SecureString ([IO.File]::ReadAllText((Resolve-Path -LiteralPath $PasswordFile).Path)) -AsPlainText -Force
 }else{
  Add-Type -AssemblyName PresentationFramework
  $window=New-Object Windows.Window
  $window.Title='LEE T License Center - First setup'
  $window.Width=460; $window.Height=300; $window.ResizeMode='NoResize'; $window.WindowStartupLocation='CenterScreen'
  $panel=New-Object Windows.Controls.StackPanel; $panel.Margin='24'
  $window.Content=$panel
  $label=New-Object Windows.Controls.TextBlock; $label.Text='Create issuer password (12 to 128 characters).'; $label.TextWrapping='Wrap'; $panel.Children.Add($label)|Out-Null
  $first=New-Object Windows.Controls.PasswordBox; $first.MaxLength=128; $first.Margin='0,12,0,12'; $panel.Children.Add($first)|Out-Null
  $label2=New-Object Windows.Controls.TextBlock; $label2.Text='Confirm password'; $panel.Children.Add($label2)|Out-Null
  $second=New-Object Windows.Controls.PasswordBox; $second.MaxLength=128; $second.Margin='0,8,0,12'; $panel.Children.Add($second)|Out-Null
  $button=New-Object Windows.Controls.Button; $button.Content='Create License Center'; $button.Height=32; $panel.Children.Add($button)|Out-Null
  $button.Add_Click({
   if($first.Password.Length -lt 12 -or $first.Password -ne $second.Password){[Windows.MessageBox]::Show('Use at least 12 characters and matching passwords.')|Out-Null;return}
   $window.DialogResult=$true
  })
  if($window.ShowDialog() -ne $true){throw 'License Center setup was cancelled.'}
  $password=$first.SecurePassword
 }
 & "$PSScriptRoot\Initialize-LocalLicenseCenter.ps1" -PostgresDirectory $pg -NodePath $node -OperatorPassword $password
 $password=$null
}else{
 # Preserve the complete ledger, signing key and operator identity on repair/upgrade.
 $settings=Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
 $db=[uri]$settings.databaseUrl
 if($db.Host -ne '127.0.0.1' -or $db.Port -ne 55435 -or $db.AbsolutePath -ne '/leet_issuer'){
  throw 'Existing data does not use the dedicated local issuer database.'
 }
 $cluster=Join-Path $root 'postgresql\cluster'
 if(-not (Test-Path -LiteralPath (Join-Path $cluster 'PG_VERSION'))){throw 'Existing issuer database is incomplete. Data was retained.'}
 if(([IO.File]::ReadAllText((Join-Path $cluster 'PG_VERSION'))).Trim() -ne '17'){throw 'PostgreSQL major version mismatch. Data was retained.'}
 $database=Get-CimInstance Win32_Service -Filter "Name='$databaseService'"
 if($database){
  if($database.PathName -notmatch ('(?i)-D\s+"'+[regex]::Escape($cluster)+'"')){throw 'Cannot verify ownership of the issuer database service. Data was retained.'}
  Stop-Service $databaseService
 }else{
  $ownership=Join-Path $root 'installation.json'
  if(-not (Test-Path -LiteralPath $ownership)){throw 'Missing issuer ownership record. Data was retained.'}
  $record=Get-Content -LiteralPath $ownership -Raw | ConvertFrom-Json
  if($record.installDirectory -ne $install -or $record.dataDirectory -ne $root){throw 'Issuer ownership mismatch. Data was retained.'}
  & (Join-Path $pg 'bin\pg_ctl.exe') register -N $databaseService -D $cluster -S demand -U 'NT AUTHORITY\NetworkService' -w | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Could not restore the dedicated issuer database service.'}
 }
 # Change only this issuer service's executable; never alter the warehouse service.
 $binary='"'+(Join-Path $pg 'bin\pg_ctl.exe')+'" runservice -N "'+$databaseService+'" -D "'+$cluster+'" -w'
 & sc.exe config $databaseService binPath= $binary start= auto | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Could not bind the issuer database to its standalone runtime.'}
 Start-Service $databaseService
}
if(-not $service){
 New-Service -Name $backendService -DisplayName 'LEE T License Center' -BinaryPathName ('"'+$hostPath+'" "'+$root+'"') -StartupType Automatic -DependsOn $databaseService | Out-Null
}
Set-Service $databaseService -StartupType Automatic
Set-Service $backendService -StartupType Automatic
& sc.exe failure $backendService reset= 86400 actions= restart/5000/restart/15000/restart/30000 | Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not configure issuer service recovery.'}
& sc.exe failureflag $backendService 1 | Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not configure issuer service failure handling.'}
& sc.exe failure $databaseService reset= 86400 actions= restart/5000/restart/15000/restart/30000 | Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not configure issuer database recovery.'}
$marker=@{schema=1;installDirectory=$install;dataDirectory=$root;databaseService=$databaseService;backendService=$backendService}
[IO.File]::WriteAllText((Join-Path $root 'installation.json'),($marker|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Start-Service $backendService
$ready=$false
for($attempt=0;$attempt -lt 100;$attempt++){
 $socket=New-Object Net.Sockets.TcpClient
 try{$socket.Connect('127.0.0.1',8444);$ready=$true;break}catch{Start-Sleep -Milliseconds 200}finally{$socket.Dispose()}
}
if(-not $ready){throw 'Issuer backend did not become ready. See C:\ProgramData\Lee T License Center\license-center-service.log.'}
Write-Output 'LEE T License Center is ready. Database and offline signing service start automatically with Windows.'
