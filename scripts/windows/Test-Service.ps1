[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$temporaryBase = $env:ProgramFiles
$root = Join-Path $temporaryBase ('Warehouse Service CI ' + [guid]::NewGuid().ToString('N'))
$serviceName = 'TatLeeWarehouseTest' + [guid]::NewGuid().ToString('N').Substring(0,8)
New-Item -ItemType Directory -Path (Join-Path $root 'scripts') -Force | Out-Null
$data = Join-Path $root 'data'
New-Item -ItemType Directory -Path $data | Out-Null
Copy-Item (Join-Path $PSScriptRoot '..\service-probe.mjs') (Join-Path $root 'scripts\service-probe.mjs')
$executable = Join-Path $root 'WarehouseService.exe'
& (Join-Path $PSScriptRoot 'Build-Service.ps1') -OutputPath $executable
$configPath = Join-Path $root 'service.private.json'
Copy-Item (Get-Command node.exe).Source (Join-Path $root 'node.exe')
$config = @{ ServiceName=$serviceName; AppRoot=$root; NodePath=(Join-Path $root 'node.exe'); EntryScript='scripts/service-probe.mjs'; Environment=@{DATA_DIR=$data} }
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
& icacls.exe $root '/inheritance:r' '/grant:r' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' '/C' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Service folder permissions failed.' }
& icacls.exe $data '/grant:r' '*S-1-5-19:(OI)(CI)M' '/T' '/C' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Service data permissions failed.' }
try {
    $credential = [Management.Automation.PSCredential]::new('NT AUTHORITY\LocalService', [Security.SecureString]::new())
    New-Service -Name $serviceName -BinaryPathName ('"' + $executable + '" "' + $configPath + '"') -StartupType Manual -Credential $credential | Out-Null
    Start-Service $serviceName
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Path (Join-Path $data 'probe-ready.txt'))) { if ((Get-Date) -gt $deadline) { throw 'Native service did not start the Node process.' }; Start-Sleep -Milliseconds 200 }
    Stop-Service $serviceName
    if (-not (Test-Path (Join-Path $data 'probe-stopped.txt'))) { throw 'Service stopped without graceful application acknowledgement.' }
    Write-Output 'Native Windows SCM / LocalService / spaced paths / graceful stdin shutdown passed.'
} catch {
    Get-WinEvent -FilterHashtable @{LogName='Application';StartTime=(Get-Date).AddMinutes(-3)} -ErrorAction SilentlyContinue | Where-Object { $_.ProviderName -in @('.NET Runtime','Application Error',$serviceName) } | Select-Object -First 8 TimeCreated,ProviderName,Message | Format-List | Out-String | Write-Output
    Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Service Control Manager';StartTime=(Get-Date).AddMinutes(-3)} -ErrorAction SilentlyContinue | Where-Object Message -Like ('*'+$serviceName+'*') | Select-Object -First 5 Message | Format-List | Out-String | Write-Output
    & icacls.exe $executable
    (Get-Acl $root).Access | Format-Table | Out-String | Write-Output
    (Get-Acl $executable).Access | Format-Table | Out-String | Write-Output
    Get-WinEvent -LogName 'Microsoft-Windows-AppLocker/EXE and DLL' -MaxEvents 5 -ErrorAction SilentlyContinue | Select-Object Message | Format-List | Out-String | Write-Output
    if(Test-Path (Join-Path $data 'warehouse-service.log')){Get-Content (Join-Path $data 'warehouse-service.log')}
    throw
} finally {
    if (Get-Service $serviceName -ErrorAction SilentlyContinue) { Stop-Service $serviceName -ErrorAction SilentlyContinue; & sc.exe delete $serviceName | Out-Null }
    Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}
