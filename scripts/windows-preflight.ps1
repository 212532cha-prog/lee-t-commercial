# Read-only Windows preflight. No install, file write, network change or secret collection.
param(
  [string]$DataPath = (Get-Location).Path,
  [string]$BackupPath1 = '',
  [string]$BackupPath2 = ''
)
$ErrorActionPreference = 'Stop'
$os = Get-CimInstance Win32_OperatingSystem
$computer = Get-CimInstance Win32_ComputerSystem
$disks = @(Get-CimInstance Win32_LogicalDisk)
$systemDrive = if ($env:SystemDrive) { $env:SystemDrive } else { 'C:' }
$systemDisk = $disks | Where-Object { $_.DeviceID -eq $systemDrive } | Select-Object -First 1
$networks = @(Get-NetIPConfiguration | Where-Object { $_.IPv4Address -and $_.IPv4DefaultGateway })
function Read-PathStatus([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return [ordered]@{ Configured = $false; Exists = $false; Free_GB = $null; WritePermission = 'NotTested' }
  }
  $resolvedPath = [System.IO.Path]::GetFullPath($PathValue)
  $root = [System.IO.Path]::GetPathRoot($resolvedPath).TrimEnd('\')
  $volume = $disks | Where-Object { $_.DeviceID -eq $root } | Select-Object -First 1
  return [ordered]@{
    Configured = $true
    Exists = (Test-Path -LiteralPath $resolvedPath -PathType Container)
    Free_GB = if ($volume) { [math]::Round($volume.FreeSpace / 1GB, 2) } else { $null }
    WritePermission = 'NotTested'
  }
}
$report = [ordered]@{
  Revision = 'REQ-20261101'
  Timestamp = (Get-Date).ToString('o')
  OS = $os.Caption
  OSVersion = $os.Version
  Architecture = $os.OSArchitecture
  RAM_GB = [math]::Round($computer.TotalPhysicalMemory / 1GB, 1)
  C_Free_GB = if ($systemDisk) { [math]::Round($systemDisk.FreeSpace / 1GB, 2) } else { $null }
  SystemDriveFull = if ($systemDisk) { $systemDisk.FreeSpace -eq 0 } else { $null }
  DataPath = (Read-PathStatus $DataPath)
  BackupPath1 = (Read-PathStatus $BackupPath1)
  BackupPath2 = (Read-PathStatus $BackupPath2)
  NetworkAdapters = @($networks | ForEach-Object { $_.InterfaceAlias })
  IPv4Addresses = @($networks | ForEach-Object { $_.IPv4Address.IPAddress })
  PowerShellVersion = $PSVersionTable.PSVersion.ToString()
  NodeVersion = if (Get-Command node -ErrorAction SilentlyContinue) { (& node --version) } else { $null }
  ServiceAutostart = 'NotTested'
  TrustedHttps = 'NotTested'
  Camera = 'NotTested'
  DatabaseRestore = 'NotTested'
}
$report | ConvertTo-Json -Depth 6
