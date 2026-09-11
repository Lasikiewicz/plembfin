# Windows packaging

The Windows distribution is an Inno Setup executable. It bundles the application UI
and server, the Windows-native `better-sqlite3` and `sharp` dependencies, the exact
Node.js runtime used by the build, and a WinSW service wrapper. The documentation
website and the large `public/demo-assets` bundle are deployed separately and are not
included in the Windows package.

The installer:

- installs application files under `Program Files\Plembfin`;
- registers the server as the `Plembfin` Windows service;
- stores runtime data under `%ProgramData%\Plembfin`;
- preselects a notification-area companion at user sign-in for quick access and server status;
- preselects a desktop shortcut for quick access to the dashboard;
- preselects a private-network firewall rule for TCP port 5055 so other devices on the LAN can connect;
- preselects opening Plembfin in the browser after installation so first-time setup is immediately available; and
- preserves runtime data when uninstalled unless the user explicitly confirms its removal.

All installer choices can be cleared. The tray option is only needed if Plembfin
should appear in the notification area and start automatically at sign-in. The desktop
shortcut is a convenience. The firewall rule is only needed when the dashboard should
be reachable from another device on the same private network; local access through
`127.0.0.1` does not require it.

The browser launch is independent of the tray choice, so both can be selected together.
It is skipped for silent installs.

When the tray option is selected, the installer starts `PlembfinTray.exe` immediately
after setup completes in the signed-in user session. On uninstall, the installer stops
the tray process and unregisters the Plembfin service before removing application files.
The tray menu also includes `Stop server`; stopping the Windows service may show the
normal Windows administrator-consent prompt.

## CI build

`.github/workflows/windows-installer.yml` builds the package automatically on pushes to
`main` and `alpha`, and supports a manual `workflow_dispatch` build. Release builds from
`main` are uploaded to GitHub Releases; alpha builds and manual builds are retained as
GitHub Actions artifacts.

The branch mapping is explicit for promotion pushes: the `Force to alpha` force-push to
`alpha` reads `changelog.alpha.json` and builds the matching alpha build, while the
`Force to main` force-push to `main` reads `changelog.json` and builds the release
installer. Manual runs default to `auto`, which follows the selected branch, but can use
an explicit channel when needed.

The workflow uses WinSW v2.11.0 as a pinned service wrapper. It downloads the wrapper
only during the Windows build and includes its license in the installed application.

## Local build on Windows

From the repository root, install the production dependencies. The locked Windows
packages include their prebuilt native binaries, so no manual native rebuild is needed:

```powershell
npm ci --omit=dev --ignore-scripts
```

Download the pinned WinSW x64 binary, then stage the application:

```powershell
$winsw = Join-Path $env:TEMP 'WinSW-x64.exe'
Invoke-WebRequest -UseBasicParsing `
  'https://github.com/winsw/winsw/releases/download/v2.11.0/WinSW-x64.exe' `
  -OutFile $winsw

node scripts/build-windows-package.js `
  --channel release `
  --winsw $winsw `
  --output dist/windows
```

Install Inno Setup 6, then compile the installer. `AppChannel` can be `release`,
`alpha-<build>`, or `develop-<build>`:

```powershell
& 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe' `
  '/DAppVersion=1.0.0' `
  '/DAppChannel=release' `
  packaging/windows/Plembfin.iss
```

The resulting installer is written to `dist/windows/installer`.

## Code signing

The CI job signs the installer when the repository secrets
`WINDOWS_SIGNING_CERTIFICATE_BASE64` and `WINDOWS_SIGNING_CERTIFICATE_PASSWORD` are
configured. Without them, the package is still built and published, but Windows may
show the normal SmartScreen warning for an unsigned executable.
