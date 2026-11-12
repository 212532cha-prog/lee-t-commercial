#ifndef PayloadDir
  #error PayloadDir is required
#endif
#ifndef BuildOutput
  #define BuildOutput "output"
#endif
[Setup]
SetupIconFile=..\..\public\brand\lee-t.ico
AppId={{438C12B7-0D5E-45D7-A4F0-CCB693E4CFE9}
AppName=LEE T License Center
AppVersion=1.0.0
VersionInfoVersion=1.0.0.0
VersionInfoProductVersion=1.0.0.0
VersionInfoProductTextVersion=1.0.0
VersionInfoOriginalFileName=LEE-T-License-Center-Setup.exe
AppPublisher=LEE T
AppVerName=LEE T License Center 1.0.0
VersionInfoDescription=LEE T License Center Installer
VersionInfoProductName=LEE T License Center
DefaultDirName={autopf}\LEE T License Center
DisableDirPage=yes
DefaultGroupName=LEE T License Center
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#BuildOutput}
OutputBaseFilename=LEE-T-License-Center-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\LeeT-License-Center.exe
CloseApplications=yes
RestartApplications=no
[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadDir}\app\scripts\windows\Stop-LicenseCenter.ps1"; Flags: dontcopy
[Icons]
Name: "{autoprograms}\LEE T License Center"; Filename: "{app}\LeeT-License-Center.exe"
Name: "{autodesktop}\LEE T License Center"; Filename: "{app}\LeeT-License-Center.exe"
[Run]
Filename: "{app}\LeeT-License-Center.exe"; Description: "Open LEE T License Center"; Flags: postinstall nowait skipifsilent runascurrentuser
[UninstallDelete]
Type: files; Name: "{app}\license-center-install.log"
[Code]
var DeleteIssuerData, ConfigurationFailed: Boolean;
function GetCustomSetupExitCode(): Integer;
begin
  if ConfigurationFailed then Result := 1 else Result := 0;
end;
function PowerShellPath(): String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;
function PrepareToInstall(var NeedsRestart: Boolean): String;
var ExitCode: Integer; Script: String;
begin
  Result := '';
  ExtractTemporaryFile('Stop-LicenseCenter.ps1');
  Script := ExpandConstant('{tmp}\Stop-LicenseCenter.ps1');
  if not Exec(PowerShellPath(), '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + Script + '" -InstallDirectory "' + ExpandConstant('{app}') + '"', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
    Result := 'Could not safely stop the existing issuer services. No database has been deleted.';
end;
procedure CurStepChanged(CurStep: TSetupStep);
var ExitCode: Integer; Parameters: String;
begin
  if CurStep = ssPostInstall then begin
    if not Exec(ExpandConstant('{app}\runtime\vc_redist.x64.exe'), '/install /quiet /norestart', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or ((ExitCode <> 0) and (ExitCode <> 3010) and (ExitCode <> 1638)) then
      RaiseException('Could not install the Microsoft Visual C++ runtime.');
    Parameters := '-NoProfile -STA -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\app\scripts\windows\Install-LicenseCenter.ps1') + '" -InstallDirectory "' + ExpandConstant('{app}') + '"';
    if ExpandConstant('{param:IssuerPasswordFile|}') <> '' then
      Parameters := Parameters + ' -PasswordFile "' + ExpandConstant('{param:IssuerPasswordFile|}') + '"';
    if not Exec(PowerShellPath(), Parameters, '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then begin
      ConfigurationFailed := True;
      RaiseException('License Center configuration failed. Existing issuer data was retained. Repair by running this installer again; see license-center-install.log in the installed program directory.');
    end;
  end;
end;
function InitializeUninstall(): Boolean;
begin
  DeleteIssuerData := ExpandConstant('{param:DeleteIssuerData|0}') = '1';
  if not UninstallSilent then
    DeleteIssuerData := MsgBox('Permanently delete all License Center customer records, payments, licenses and signing keys?' + #13#10 + 'Choose No to keep them for reinstalling. Warehouse data is separate.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
  Result := True;
end;
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var ExitCode: Integer; Parameters: String;
begin
  if CurUninstallStep = usUninstall then begin
    Parameters := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\app\scripts\windows\Remove-LicenseCenter.ps1') + '" -InstallDirectory "' + ExpandConstant('{app}') + '"';
    if DeleteIssuerData then Parameters := Parameters + ' -DeleteIssuerData';
    if not Exec(PowerShellPath(), Parameters, '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
      RaiseException('Could not safely remove the issuer services. Issuer data was retained.');
  end;
end;
