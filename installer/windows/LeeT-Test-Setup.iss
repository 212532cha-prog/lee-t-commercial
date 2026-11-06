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
  HttpsPage: TInputFileWizardPage;
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
    'Confirm the test issuer and warehouse network.',
    'Leave the IPv4 address blank to detect a single private network address.');
  OptionsPage.Add('Issuer key ID', False);
  OptionsPage.Values[0] := 'leet-test-20261106';
  OptionsPage.Add('Warehouse IPv4 address (optional)', False);
  OptionsPage.Add('Warehouse HTTPS hostname (optional)', False);
  HttpsPage := CreateInputFilePage(OptionsPage.ID, 'Warehouse HTTPS certificate',
    'Select a publicly trusted PFX for the warehouse hostname.',
    'Leave this empty for a test installation that uses a local CA.');
  HttpsPage.Add('Warehouse PFX (optional)', 'PKCS #12 (*.pfx;*.p12)|*.pfx;*.p12', '.pfx');
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
  else if ((Trim(OptionsPage.Values[2]) = '') <> (Trim(HttpsPage.Values[0]) = '')) then
    Result := 'Provide both the warehouse HTTPS hostname and its PFX file.'
  else if (Trim(HttpsPage.Values[0]) <> '') and not FileExists(HttpsPage.Values[0]) then
    Result := 'Select an existing warehouse PFX file.'
  else if (Pos('"', OptionsPage.Values[2]) > 0) or (Pos('"', OptionsPage.Values[0]) > 0) or (Pos('"', OptionsPage.Values[1]) > 0) then
    Result := 'Quotes are not allowed in the issuer ID, IPv4 address or hostname.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  PowerShell, Script, Arguments: String;
begin
  if CurStep <> ssPostInstall then Exit;
  PowerShell := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  Script := ExpandConstant('{app}\app\scripts\windows\Install-CommercialPayload.ps1');
  Arguments := '-NoProfile -ExecutionPolicy Bypass -File ' + AddQuotes(Script) +
    ' -PayloadDirectory ' + AddQuotes(ExpandConstant('{app}')) +
    ' -LicenseDirectory ' + AddQuotes(RemoveBackslashUnlessRoot(LicensePage.Values[0])) +
    ' -IssuerPublicKey ' + AddQuotes(KeyPage.Values[0]) +
    ' -IssuerKeyId ' + AddQuotes(Trim(OptionsPage.Values[0]));
  if Trim(OptionsPage.Values[1]) <> '' then
    Arguments := Arguments + ' -Address ' + AddQuotes(Trim(OptionsPage.Values[1]));
  if Trim(OptionsPage.Values[2]) <> '' then
    Arguments := Arguments + ' -HttpsHostname ' + AddQuotes(Trim(OptionsPage.Values[2])) +
      ' -HttpsPfxPath ' + AddQuotes(HttpsPage.Values[0]);
  if not Exec(PowerShell, Arguments, ExpandConstant('{app}'), SW_SHOWNORMAL,
      ewWaitUntilTerminated, ProvisionResult) then
    ProvisionResult := 1;
  if ProvisionResult <> 0 then
    SuppressibleMsgBox('The warehouse service was not confirmed installed. Keep the displayed setup error for diagnosis.', mbError, MB_OK, IDOK);
end;

function GetCustomSetupExitCode: Integer;
begin
  Result := ProvisionResult;
end;
