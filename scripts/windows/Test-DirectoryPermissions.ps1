#Requires -RunAsAdministrator
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Protect-Directory.ps1')
$root=Join-Path $env:TEMP ('leet-access-'+[guid]::NewGuid().ToString('N'))
$account='leet'+[guid]::NewGuid().ToString('N').Substring(0,12)
$password=[string]::Concat([guid]::NewGuid().ToString('N'),[guid]::NewGuid().ToString('N'),'aA1!')
$created=$false
try {
 New-LocalUser -Name $account -Password (ConvertTo-SecureString $password -AsPlainText -Force) -AccountNeverExpires -PasswordNeverExpires | Out-Null
 $created=$true
 # Localized Windows names are not assumed. Ensure a standard Users token, never Administrators.
 $users=([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')).Translate([Security.Principal.NTAccount]).Value.Split('\')[-1]
 $accountSid=(Get-LocalUser -Name $account).SID.Value
 if(-not @(Get-LocalGroupMember -Group $users | Where-Object {$_.SID.Value -eq $accountSid}).Count){Add-LocalGroupMember -Group $users -Member $account}
 $program=Join-Path $root 'program'
 $private=Join-Path $root 'private'
 $activation=Join-Path $program 'activation'
 New-Item -ItemType Directory -Path $program,$private,$activation -Force | Out-Null
 $executable=Join-Path $program 'desktop.exe'
 $config=Join-Path $private 'service.private.json'
 $license=Join-Path $activation 'license.json'
 [IO.File]::WriteAllText($executable,'immutable desktop test fixture')
 [IO.File]::WriteAllText($config,'private database credential fixture')
 [IO.File]::WriteAllText($license,'signed license fixture')
 # Reproduce an existing folder with an explicit broad grant. The production helper must remove it.
 foreach($path in @($program,$private,$activation)){
  & icacls.exe $path '/grant:r' '*S-1-5-32-545:(OI)(CI)F' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Cannot stage the permission regression fixture.'}
 }
 Protect-Directory $program 'RX' -AllowDesktopRead
 Protect-Directory $private 'M'
 Protect-Directory $activation 'RX'
 foreach($path in @($program,$private,$activation)){
  $acl=Get-Acl -LiteralPath $path
  if(-not $acl.AreAccessRulesProtected){throw 'Directory inheritance was not disabled.'}
  $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  $expected=if($path -eq $program){4}else{3}
  if($rules.Count -ne $expected -or @($rules | Where-Object {$_.IsInherited -or $_.AccessControlType -ne 'Allow'}).Count){throw 'Unexpected permission grant survived protection.'}
 }
 Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class LeeTStandardAccessProbe {
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern bool LogonUser(string user, string domain, string password, int type, int provider, out IntPtr token);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
 static void Denied(Action action) {
  try { action(); } catch(UnauthorizedAccessException) { return; }
  throw new Exception("A standard account received forbidden file access.");
 }
 public static void Check(string user, string password, string program, string executable, string config, string license) {
  IntPtr token;
  if(!LogonUser(user, Environment.MachineName, password, 2, 0, out token))
   throw new Exception("Cannot obtain the isolated standard-user test token: "+Marshal.GetLastWin32Error());
  try {
   using(var identity=new WindowsIdentity(token))
   using(var context=identity.Impersonate()) {
    if(new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
     throw new Exception("The permission probe must not run as administrator.");
    if(File.ReadAllText(executable)!="immutable desktop test fixture") throw new Exception("Desktop program cannot be read.");
    var executeHandle=CreateFile(executable,0x20000000,7,IntPtr.Zero,3,0,IntPtr.Zero);
    if(executeHandle==new IntPtr(-1)) throw new Exception("Desktop program execute access was denied.");
    CloseHandle(executeHandle);
    Denied(()=>File.AppendAllText(executable,"tampered"));
    Denied(()=>File.WriteAllText(Path.Combine(program,"injected.exe"),"injected"));
    Denied(()=>File.ReadAllText(config));
    Denied(()=>File.AppendAllText(config,"tampered"));
    Denied(()=>File.ReadAllText(license));
    Denied(()=>File.AppendAllText(license,"tampered"));
   }
  } finally { CloseHandle(token); }
 }
}
'@
 [LeeTStandardAccessProbe]::Check($account,$password,$program,$executable,$config,$license)
 if([IO.File]::ReadAllText($executable) -ne 'immutable desktop test fixture' -or
    [IO.File]::ReadAllText($config) -ne 'private database credential fixture' -or
    [IO.File]::ReadAllText($license) -ne 'signed license fixture'){throw 'The standard-user test changed protected files.'}
 Write-Output 'Actual standard-user token: program read/execute allowed; program write/injection, private config and license read/write denied; inherited and explicit broad grants removed.'
} finally {
 $password=$null
 if($created){Remove-LocalUser -Name $account}
 if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force}
}
