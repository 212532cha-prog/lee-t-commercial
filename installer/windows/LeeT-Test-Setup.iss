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
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if DirExists(ExpandConstant('{app}')) or DirExists(ExpandConstant('{commonappdata}\Lee T Commercial')) then
    Result := 'This test setup requires a new installation. An existing directory was found.'
  else if not FileExists(AddBackslash(LicensePage.Values[0]) + 'installation-id') or
      not FileExists(AddBackslash(LicensePage.Values[0]) + 'license.json') then
    Result := 'The selected directory does not contain an imported test license.'
  else if not FileExists(KeyPage.Values[0]) or (Trim(OptionsPage.Values[0]) = '') then
    Result := 'Select the issuer public key and enter its key ID.'
  else if Pos('"', OptionsPage.Values[0]) > 0 then
    Result := 'Quotes are not allowed in the issuer ID.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  PowerShell, Script, Arguments: String;
  BrowserResult: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  PowerShell := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  Script := ExpandConstant('{app}\app\scripts\windows\Install-CommercialPayload.ps1');
  Arguments := '-NoProfile -ExecutionPolicy Bypass -File ' + AddQuotes(Script) +
    ' -PayloadDirectory ' + AddQuotes(ExpandConstant('{app}')) +
    ' -LicenseDirectory ' + AddQuotes(RemoveBackslashUnlessRoot(LicensePage.Values[0])) +
    ' -IssuerPublicKey ' + AddQuotes(KeyPage.Values[0]) +
    ' -IssuerKeyId ' + AddQuotes(Trim(OptionsPage.Values[0])) + ' -ConfirmNetworkTrust';
  if not Exec(PowerShell, Arguments, ExpandConstant('{app}'), SW_SHOWNORMAL,
      ewWaitUntilTerminated, ProvisionResult) then
    ProvisionResult := 1;
  if ProvisionResult <> 0 then
    SuppressibleMsgBox('The warehouse service was not confirmed installed. Keep the displayed setup error for diagnosis.', mbError, MB_OK, IDOK)
  else if not WizardSilent then
    ShellExecAsOriginalUser('open', 'https://localhost:3443/', '', '', SW_SHOWNORMAL, ewNoWait, BrowserResult);
end;

function GetCustomSetupExitCode: Integer;
begin
  Result := ProvisionResult;
end;
