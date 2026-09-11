#define MyAppName "Plembfin"
#define MyAppPublisher "Plembfin"
#define MyAppURL "https://plembfin.com"

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef AppChannel
  #define AppChannel "release"
#endif

[Setup]
AppId={{6B30F782-3A46-4F1B-9A69-9A0B17F4C58D}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppVerName={#MyAppName} {#AppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\Plembfin
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist\windows\installer
OutputBaseFilename=Plembfin-Setup-{#AppChannel}-{#AppVersion}
SetupIconFile=..\..\dist\windows\app\plembfin.ico
UninstallDisplayIcon={app}\plembfin.ico
LicenseFile=..\..\LICENSE.md
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartIfNeededByRun=no
CreateUninstallRegKey=yes
Uninstallable=yes
AllowNoIcons=yes
AppMutex=PlembfinService
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription=Plembfin Windows installer
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#AppVersion}
VersionInfoTextVersion={#AppVersion}
VersionInfoCopyright=Copyright (C) Plembfin contributors

[Tasks]
Name: "tray"; Description: "Start Plembfin in the notification area when I sign in (quick access and server status)"; GroupDescription: "Startup options:"; Flags: checkedonce
Name: "desktopicon"; Description: "Create a desktop shortcut (quick access to the dashboard)"; GroupDescription: "Additional shortcuts:"; Flags: checkedonce
Name: "firewall"; Description: "Allow private-network connections on TCP 5055 (needed only for access from other devices on your LAN)"; GroupDescription: "Network access:"; Flags: checkedonce
Name: "launch"; Description: "Open Plembfin in your browser after installation (recommended to finish setup)"; GroupDescription: "After installation:"; Flags: checkedonce

[Dirs]
Name: "{commonappdata}\Plembfin"
Name: "{commonappdata}\Plembfin\logs"

[Files]
Source: "..\..\dist\windows\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Plembfin\Open Plembfin"; Filename: "{app}\PlembfinTray.exe"; Parameters: "--open"; WorkingDir: "{app}"; IconFilename: "{app}\plembfin.ico"; Comment: "Open the Plembfin dashboard"
Name: "{autoprograms}\Plembfin\Plembfin notification area"; Filename: "{app}\PlembfinTray.exe"; WorkingDir: "{app}"; IconFilename: "{app}\plembfin.ico"; Comment: "Show Plembfin status in the notification area"
Name: "{autodesktop}\Plembfin"; Filename: "{app}\PlembfinTray.exe"; Parameters: "--open"; WorkingDir: "{app}"; IconFilename: "{app}\plembfin.ico"; Tasks: desktopicon; Comment: "Open the Plembfin dashboard"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Plembfin"; ValueData: """{app}\PlembfinTray.exe"""; Flags: uninsdeletevalue; Tasks: tray

[InstallDelete]
Type: files; Name: "{userstartup}\Plembfin notification area.lnk"

[Run]
Filename: "{app}\PlembfinTray.exe"; Description: "Start Plembfin in the notification area"; Flags: postinstall nowait runasoriginaluser; Tasks: tray
Filename: "{app}\PlembfinTray.exe"; Parameters: "--open"; Description: "Open Plembfin"; Flags: postinstall nowait skipifsilent runasoriginaluser; Tasks: launch
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Plembfin (Private)"" dir=in action=allow protocol=TCP localport=5055 profile=private"; Flags: runhidden waituntilterminated; Tasks: firewall

[UninstallRun]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Plembfin (Private)"""; Flags: runhidden waituntilterminated

[Code]
const
  PlembfinServiceName = 'Plembfin';

function RunServiceCommand(const Arguments: String; var ResultCode: Integer): Boolean;
begin
  Result := Exec(
    ExpandConstant('{app}\PlembfinService.exe'),
    Arguments,
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode) and (ResultCode = 0);
end;

function ServiceExists: Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(
    ExpandConstant('{sys}\sc.exe'),
    'query "' + PlembfinServiceName + '"',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode) and (ResultCode = 0);
end;

function StopRegisteredService: Boolean;
var
  ResultCode: Integer;
begin
  Result := False;

  if FileExists(ExpandConstant('{app}\PlembfinService.exe')) then begin
    Result := RunServiceCommand('stop', ResultCode);
  end;

  { Fall back to the Service Control Manager if the wrapper is missing or cannot stop the service. }
  if not Result then begin
    Exec(
      ExpandConstant('{sys}\sc.exe'),
      'stop "' + PlembfinServiceName + '"',
      '',
      SW_HIDE,
      ewWaitUntilTerminated,
      ResultCode);
    { 1062 means the service was already stopped. }
    Result := (ResultCode = 0) or (ResultCode = 1062);
  end;
end;

function RemoveRegisteredService: Boolean;
var
  ResultCode: Integer;
begin
  Result := False;

  if FileExists(ExpandConstant('{app}\PlembfinService.exe')) then begin
    Result := RunServiceCommand('uninstall', ResultCode);
  end;

  { Do not leave a stale service behind if the wrapper was already removed. }
  if not Result then begin
    Exec(
      ExpandConstant('{sys}\sc.exe'),
      'delete "' + PlembfinServiceName + '"',
      '',
      SW_HIDE,
      ewWaitUntilTerminated,
      ResultCode);
    { 1060 means the service no longer exists. }
    Result := (ResultCode = 0) or (ResultCode = 1060);
  end;
end;

procedure CloseInstalledProcesses;
var
  ResultCode: Integer;
begin
  { The tray is not a Windows service, so stop it explicitly before files are removed. }
  Exec(
    ExpandConstant('{sys}\taskkill.exe'),
    '/F /T /IM PlembfinTray.exe',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  NeedsRestart := False;
  CloseInstalledProcesses;
  if ServiceExists then begin
    { Stop the previous server before Inno replaces its native modules. }
    StopRegisteredService;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  ServiceReady: Boolean;
begin
  if CurStep <> ssPostInstall then Exit;

  if not WizardIsTaskSelected('tray') then begin
    { Remove a startup choice that may have been disabled during an upgrade. }
    RegDeleteValue(HKEY_CURRENT_USER, 'Software\Microsoft\Windows\CurrentVersion\Run', 'Plembfin');
  end;

  ServiceReady := False;
  if ServiceExists then begin
    ServiceReady := RunServiceCommand('refresh', ResultCode);
  end else begin
    ServiceReady := RunServiceCommand('install', ResultCode);
  end;

  if not ServiceReady then begin
    MsgBox(
      'Plembfin was installed, but its Windows service could not be registered. You can retry from an elevated terminal with PlembfinService.exe install.',
      mbError,
      MB_OK);
    Exit;
  end;

  if not RunServiceCommand('start', ResultCode) then begin
    MsgBox(
      'Plembfin was installed, but its Windows service could not be started. Check the service logs under %ProgramData%\\Plembfin\\logs\\service.',
      mbError,
      MB_OK);
  end;
end;

function InitializeUninstall: Boolean;
begin
  Result := True;
  CloseInstalledProcesses;
  RegDeleteValue(HKEY_CURRENT_USER, 'Software\Microsoft\Windows\CurrentVersion\Run', 'Plembfin');
  if not ServiceExists then Exit;

  { Stop and unregister the service before Inno deletes the installed files. }
  StopRegisteredService;
  RemoveRegisteredService;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep <> usPostUninstall) or UninstallSilent then Exit;
  if not DirExists(ExpandConstant('{commonappdata}\Plembfin')) then Exit;

  if MsgBox(
    'Do you also want to delete Plembfin''s database, artwork cache, logs, and backups? This cannot be undone.',
    mbConfirmation,
    MB_YESNO) = IDYES then begin
    DelTree(ExpandConstant('{commonappdata}\Plembfin'), True, True, True);
  end;
end;
