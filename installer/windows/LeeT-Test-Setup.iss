#ifndef PayloadDir
  #error Provide PayloadDir with the staged commercial payload
#endif
#ifndef BuildOutput
  #error Provide BuildOutput for the setup executable
#endif
#ifdef OfflineIssuerPublicKey
  #ifndef OfflineIssuerKeyId
    #error Provide OfflineIssuerKeyId with OfflineIssuerPublicKey
  #endif
#else
  #ifdef OfflineIssuerKeyId
    #error Provide OfflineIssuerPublicKey with OfflineIssuerKeyId
  #endif
#endif

[Setup]
AppId=LeeTCommercialWarehouseTest
SetupMutex=LeeTCommercialWarehouseTestSetup
AppName=LEE T Commercial Warehouse Test
AppVersion=0.8.5
DefaultDirName={autopf}\Lee T Commercial
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Uninstallable=no
OutputDir={#BuildOutput}
#ifdef OfflineIssuerPublicKey
OutputBaseFilename=LeeT-Offline-Setup
#else
OutputBaseFilename=LeeT-Test-Setup
#endif
Compression=lzma2
SolidCompression=yes

[Files]
#ifdef OfflineIssuerPublicKey
Source: "{#OfflineIssuerPublicKey}"; DestDir: "{tmp}\activation"; DestName: "bundled-issuer-public.pem"; Flags: dontcopy
#endif
Source: "{#PayloadDir}\desktop\*"; DestDir: "{tmp}\activation\desktop"; Flags: dontcopy recursesubdirs
Source: "{#PayloadDir}\runtime\node.exe"; DestDir: "{tmp}\activation\runtime"; Flags: dontcopy
Source: "{#PayloadDir}\app\package.json"; DestDir: "{tmp}\activation\app"; Flags: dontcopy
Source: "{#PayloadDir}\app\src\*"; DestDir: "{tmp}\activation\app\src"; Flags: dontcopy recursesubdirs
Source: "{#PayloadDir}\app\scripts\desktop-activation.mjs"; DestDir: "{tmp}\activation\app\scripts"; Flags: dontcopy
Source: "{#PayloadDir}\app\scripts\windows\New-DesktopActivationConfig.ps1"; DestDir: "{tmp}\activation\app\scripts\windows"; Flags: dontcopy
Source: "{#PayloadDir}\app\scripts\windows\Protect-Directory.ps1"; DestDir: "{tmp}\activation\app\scripts\windows"; Flags: dontcopy
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Code]
var
  ActivationPage: TInputOptionWizardPage;
  LicensePage: TInputDirWizardPage;
  KeyPage: TInputFileWizardPage;
  OptionsPage: TInputQueryWizardPage;
  DataPage: TInputDirWizardPage;
  ProvisionResult: Integer;
  InstallLicenseDir, InstallIssuerKey, InstallIssuerKeyId: String;

procedure InitializeWizard;
begin
  ActivationPage := CreateInputOptionPage(wpSelectDir, 'Test activation',
    'Choose how to activate this installation.',
    'Use the supplied test issuer key for either option.', True, False);
  ActivationPage.Add('Open the activation window');
  ActivationPage.Add('Use a test license that is already imported');
  ActivationPage.SelectedValueIndex := 0;
  LicensePage := CreateInputDirPage(ActivationPage.ID, 'Existing test license',
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

function ShouldSkipPage(PageID: Integer): Boolean;
begin
#ifdef OfflineIssuerPublicKey
  Result := (PageID = ActivationPage.ID) or (PageID = LicensePage.ID) or
    (PageID = KeyPage.ID) or (PageID = OptionsPage.ID);
#else
  Result := (PageID = LicensePage.ID) and (ActivationPage.SelectedValueIndex = 0);
#endif
end;

function PrepareNativeActivation: String;
var
  Bootstrap, Script, PowerShell, Arguments, ActivationMode: String;
  ExitCode: Integer;
begin
  Result := 'The LEE T activation window could not start.';
  if WizardSilent then begin
    Result := 'Open Setup interactively to activate LEE T.';
    Exit;
  end;
  Bootstrap := ExpandConstant('{tmp}\activation');
  try
    ExtractTemporaryFiles('{tmp}\activation\*');
  except
    Exit;
  end;
#ifdef OfflineIssuerPublicKey
  InstallIssuerKey := AddBackslash(Bootstrap) + 'bundled-issuer-public.pem';
  ActivationMode := '--activate-offline';
#else
  ActivationMode := '--activate';
#endif
  PowerShell := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  Script := AddBackslash(Bootstrap) + 'app\scripts\windows\New-DesktopActivationConfig.ps1';
  Arguments := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + AddQuotes(Script) +
    ' -PayloadDirectory ' + AddQuotes(Bootstrap) +
    ' -LicenseDirectory ' + AddQuotes(InstallLicenseDir) +
    ' -IssuerPublicKey ' + AddQuotes(InstallIssuerKey) +
    ' -IssuerKeyId ' + AddQuotes(InstallIssuerKeyId) + ' -InstallerCache';
  if not Exec(PowerShell, Arguments, Bootstrap, SW_HIDE, ewWaitUntilTerminated, ExitCode) then Exit;
  if ExitCode <> 0 then begin
#ifdef OfflineIssuerPublicKey
    Result := 'Setup could not prepare offline activation. Reopen the same installer or contact your LEE T provider.';
#else
    Result := 'Setup could not prepare activation. Use the original issuer key and key ID, or contact the test issuer.';
#endif
    Exit;
  end;
  if not Exec(AddBackslash(Bootstrap) + 'desktop\LeeT.Warehouse.exe', ActivationMode, Bootstrap,
      SW_SHOWNORMAL, ewWaitUntilTerminated, ExitCode) then Exit;
  if ExitCode = 10 then
    Result := 'Activation was closed. Reopen the same installer to continue.'
  else if ExitCode = 0 then begin
    InstallIssuerKey := AddBackslash(InstallLicenseDir) + 'issuer-public.pem';
    Result := '';
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  DataDrive, AppDrive, DataPath, AppPath, CachePath: String;
  FreeBytes, TotalBytes: Int64;
begin
  Result := '';
  if DirExists(ExpandConstant('{app}')) or DirExists(DataPage.Values[0]) then
    Result := 'This test setup requires a new installation. An existing directory was found.'
  else if Trim(DataPage.Values[0]) = '' then
    Result := 'Choose a warehouse data directory.';
#ifndef OfflineIssuerPublicKey
  if Result <> '' then Exit;
  if (ActivationPage.SelectedValueIndex = 1) and
      ((not FileExists(AddBackslash(LicensePage.Values[0]) + 'installation-id')) or
       (not FileExists(AddBackslash(LicensePage.Values[0]) + 'license.json'))) then
    Result := 'The selected directory does not contain an imported test license.'
  else if not FileExists(KeyPage.Values[0]) or (Trim(OptionsPage.Values[0]) = '') then
    Result := 'Select the issuer public key and enter its key ID.'
  else if Pos('"', OptionsPage.Values[0]) > 0 then
    Result := 'Quotes are not allowed in the issuer ID.';
#endif
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
  if Result <> '' then Exit;
#ifdef OfflineIssuerPublicKey
  InstallIssuerKeyId := '{#OfflineIssuerKeyId}';
#else
  InstallIssuerKey := KeyPage.Values[0];
  InstallIssuerKeyId := Trim(OptionsPage.Values[0]);
#endif
  InstallLicenseDir := RemoveBackslashUnlessRoot(LicensePage.Values[0]);
  if ActivationPage.SelectedValueIndex = 0 then begin
#ifdef OfflineIssuerPublicKey
    InstallLicenseDir := ExpandConstant('{commonpf64}\Lee T Offline Activation');
#else
    InstallLicenseDir := ExpandConstant('{commonpf64}\Lee T Test Activation');
#endif
    CachePath := Lowercase(AddBackslash(InstallLicenseDir));
    if (Pos(CachePath, DataPath) = 1) or (Pos(DataPath, CachePath) = 1) or
       (Pos(CachePath, AppPath) = 1) or (Pos(AppPath, CachePath) = 1) then
      Result := 'Choose application and data directories outside the protected activation folder.'
    else
      Result := PrepareNativeActivation;
  end;
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
    ' -LicenseDirectory ' + AddQuotes(InstallLicenseDir) +
    ' -IssuerPublicKey ' + AddQuotes(InstallIssuerKey) +
    ' -IssuerKeyId ' + AddQuotes(InstallIssuerKeyId) + ' -ConfirmNetworkTrust -GuiSetup';
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
