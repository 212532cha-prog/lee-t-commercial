#ifndef PayloadDir
  #error Provide PayloadDir with the staged commercial payload
#endif
#ifndef BuildOutput
  #error Provide BuildOutput for the setup executable
#endif

[Setup]
AppId=LeeTCommercialWarehouseTest
AppName=LEE T Commercial Warehouse Test
AppVersion=0.8.5
DefaultDirName={autopf}\Lee T Commercial
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Uninstallable=no
OutputDir={#BuildOutput}
OutputBaseFilename=LeeT-Test-Setup
Compression=lzma2
SolidCompression=yes

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Code]
var
  LicensePage: TInputDirWizardPage;
  KeyPage: TInputFileWizardPage;
  OptionsPage: TInputQueryWizardPage;
  DataPage: TInputDirWizardPage;
  ProvisionResult: Integer;

procedure InitializeWizard;
begin
  LicensePage := CreateInputDirPage(wpSelectDir, 'Existing test license',
    'Choose the directory containing the imported Lee T test license.',
    'The directory must contain installation-id and license.json.', False, '');
  LicensePage.Add('License directory');
  LicensePage.Values[0] := ExpandConstant('{localappdata}\LeeT-Test\license');
  KeyPage := CreateInputFilePage(LicensePage.ID, 'Issuer public key',
    'Select the public key provided with the test license.',
    'This is the leet-test-public.pem file.');
  KeyPage.Add('Public key', 'Public key (*.pem)|*.pem', '.pem');
  OptionsPage := CreateInputQueryPage(KeyPage.ID, 'Warehouse connection',
    'Confirm the test license issuer.',
    'Setup detects the warehouse address from the trusted Windows network.');
  OptionsPage.Add('Issuer key ID', False);
  OptionsPage.Values[0] := 'leet-test-20261106';
  DataPage := CreateInputDirPage(OptionsPage.ID, 'Warehouse data location',
    'Choose a new directory for the warehouse database and files.',
    'Choose another local NTFS drive if the system drive is short on space.', False, '');
  DataPage.Add('Data directory');
  DataPage.Values[0] := ExpandConstant('{commonappdata}\Lee T Commercial');
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  DataDrive, AppDrive, DataPath, AppPath: String;
  FreeBytes, TotalBytes: Int64;
begin
  Result := '';
  if DirExists(ExpandConstant('{app}')) or DirExists(DataPage.Values[0]) then
    Result := 'This test setup requires a new installation. An existing directory was found.'
  else if Trim(DataPage.Values[0]) = '' then
    Result := 'Choose a warehouse data directory.'
  else if not FileExists(AddBackslash(LicensePage.Values[0]) + 'installation-id') or
      not FileExists(AddBackslash(LicensePage.Values[0]) + 'license.json') then
    Result := 'The selected directory does not contain an imported test license.'
  else if not FileExists(KeyPage.Values[0]) or (Trim(OptionsPage.Values[0]) = '') then
    Result := 'Select the issuer public key and enter its key ID.'
  else if Pos('"', OptionsPage.Values[0]) > 0 then
    Result := 'Quotes are not allowed in the issuer ID.';
  if Result <> '' then Exit;
  DataDrive := ExtractFileDrive(DataPage.Values[0]);
  if (Length(DataDrive) <> 2) or (Pos(':\', DataPage.Values[0]) <> 2) or
      (Pos('"', DataPage.Values[0]) > 0) then begin
    Result := 'Choose an absolute directory on a local data drive.';
    Exit;
  end;
  DataPath := Lowercase(AddBackslash(ExpandFileName(DataPage.Values[0])));
  AppPath := Lowercase(AddBackslash(ExpandConstant('{app}')));
  if (DataPath = Lowercase(AddBackslash(DataDrive))) or
      (Pos(DataPath, AppPath) = 1) or (Pos(AppPath, DataPath) = 1) then begin
    Result := 'Choose a dedicated data directory outside the application directory.';
    Exit;
  end;
  if RegKeyExists(HKLM, 'SYSTEM\CurrentControlSet\Services\LeeTCommercialWarehouse') or
      RegKeyExists(HKLM, 'SYSTEM\CurrentControlSet\Services\LeeTPostgreSQL17') then begin
    Result := 'An existing LEE T service was found. Use the update or migration procedure to protect its data.';
    Exit;
  end;
  if not GetSpaceOnDisk64(AddBackslash(DataDrive), FreeBytes, TotalBytes) then
    Result := 'Cannot check the selected data drive.'
  else if FreeBytes < 2147483648 then
    Result := 'The data drive needs at least 2 GB free. Choose another drive or free space first.';
  if Result <> '' then Exit;
  AppDrive := AddBackslash(ExtractFileDrive(ExpandConstant('{app}')));
  if not GetSpaceOnDisk64(AppDrive, FreeBytes, TotalBytes) then
    Result := 'Cannot check the application drive.'
  else if FreeBytes < 1073741824 then
    Result := 'The application drive needs at least 1 GB free. Select another drive or free space first.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  PowerShell, Script, Arguments: String;
  Desktop, RuntimeInstaller: String;
  DesktopResult: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  Desktop := ExpandConstant('{app}\desktop\LeeT.Warehouse.exe');
  RuntimeInstaller := ExpandConstant('{app}\runtime\WebView2RuntimeInstaller.exe');
  if not Exec(Desktop, '--check-runtime', '', SW_HIDE, ewWaitUntilTerminated, DesktopResult) then
    DesktopResult := 1;
  if DesktopResult <> 0 then begin
    if not Exec(RuntimeInstaller, '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, DesktopResult) then
      DesktopResult := 1;
    if (DesktopResult = 0) or (DesktopResult = 3010) then
      if not Exec(Desktop, '--check-runtime', '', SW_HIDE, ewWaitUntilTerminated, DesktopResult) then
        DesktopResult := 1;
    if DesktopResult <> 0 then begin
      ProvisionResult := DesktopResult;
      SuppressibleMsgBox('The LEE T desktop runtime could not be installed.', mbError, MB_OK, IDOK);
      Exit;
    end;
  end;
  PowerShell := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  Script := ExpandConstant('{app}\app\scripts\windows\Install-CommercialPayload.ps1');
  Arguments := '-NoProfile -ExecutionPolicy Bypass -File ' + AddQuotes(Script) +
    ' -PayloadDirectory ' + AddQuotes(ExpandConstant('{app}')) +
    ' -DataRoot ' + AddQuotes(RemoveBackslashUnlessRoot(DataPage.Values[0])) +
    ' -LicenseDirectory ' + AddQuotes(RemoveBackslashUnlessRoot(LicensePage.Values[0])) +
    ' -IssuerPublicKey ' + AddQuotes(KeyPage.Values[0]) +
    ' -IssuerKeyId ' + AddQuotes(Trim(OptionsPage.Values[0])) + ' -ConfirmNetworkTrust -GuiSetup';
  if not Exec(PowerShell, Arguments, ExpandConstant('{app}'), SW_SHOWNORMAL,
      ewWaitUntilTerminated, ProvisionResult) then
    ProvisionResult := 1;
  if ProvisionResult <> 0 then
    SuppressibleMsgBox('The warehouse service was not confirmed installed. Keep the displayed setup error for diagnosis.', mbError, MB_OK, IDOK)
  else begin
    CreateShellLink(ExpandConstant('{commonprograms}\LEE T Warehouse.lnk'), 'LEE T Warehouse',
      Desktop, '', ExpandConstant('{app}\desktop'), Desktop, 0, SW_SHOWNORMAL);
    CreateShellLink(ExpandConstant('{commondesktop}\LEE T Warehouse.lnk'), 'LEE T Warehouse',
      Desktop, '', ExpandConstant('{app}\desktop'), Desktop, 0, SW_SHOWNORMAL);
    if not WizardSilent then
      ExecAsOriginalUser(Desktop, '', ExpandConstant('{app}\desktop'), SW_SHOWNORMAL, ewNoWait, DesktopResult);
  end;
end;

function GetCustomSetupExitCode: Integer;
begin
  Result := ProvisionResult;
end;
