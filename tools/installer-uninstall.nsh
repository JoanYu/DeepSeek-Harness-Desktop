; Custom NSIS hooks for the DeepSeek Harness Desktop installer.
;
; electron-builder emits a generated uninstaller that already knows how to remove
; the app's installation directory and its registry entries. What it cannot know
; is where the running app keeps the user's profile — the kernel home is created
; at runtime under the OS user-profile directory (on Windows: %APPDATA% for
; per-user installs), not in the install directory, and a user who does not opt
; in to removing it would otherwise have to hunt it down by hand.
;
; This file is `!include`'d into the generated NSIS script and contributes two
; hooks:
;
;   customInstall
;     Runs near the end of the install section (after files are copied and
;     shortcuts are placed), before the installer is asked whether to launch
;     the app. Used here to print a one-line note so the user knows where
;     their profile will live once they run the app for the first time.
;
;   customUnInstall
;     Runs at the start of the uninstall section, while the install directory
;     is still on disk (file removal happens later in the same section). Used
;     here to ask the user whether to also remove the profile directory, and
;     to do so if they say yes. The prompt is a `MessageBox MB_YESNO` — the
;     same pattern every Windows installer uses for "remove everything?"
;     questions.
;
; Variables provided by the generated script:
;   $INSTDIR          the directory the user chose during install
;   $APPDATA          the per-user roaming application data folder
;   ${APP_FILENAME}   sanitized productFilename (per package.json `productName`),
;                     which is also the directory name Electron uses for
;                     `app.getPath('userData')` on Windows

; The NSIS `ShowInstDetails` / `ShowUninstDetails` switches control whether the
; install/uninstall progress page shows the scrollback of every operation. The
; defaults are `hide` — silent installs go faster, but for a desktop app where
; the user is sitting watching the dialog, "always" is what they want. These
; are global settings; calling them here is the recommended hook point.
ShowInstDetails show
ShowUninstDetails show

!macro customInstall
  DetailPrint "Profile location: $APPDATA\${APP_FILENAME}\kernel-home (created on first launch)"
!macroend

!macro customUnInstall
  ; Mirror the path the running app would use. Electron defaults the userData
  ; path to %APPDATA%\<productName> on Windows for per-user installs, which is
  ; the configuration this installer uses (`perMachine: false`).
  StrCpy $0 "$APPDATA\${APP_FILENAME}\kernel-home"

  IfFileExists "$0\*.*" 0 done
    MessageBox MB_YESNO|MB_ICONQUESTION "Do you also want to remove your profile data?$\r$\n$\r$\nThis will delete your installed plugins, conversations, and settings.$\r$\n$\r$\nLocation: $0$\r$\n$\r$\nChoose 'No' to keep your profile for a future reinstall." IDYES remove IDNO done
    remove:
      DetailPrint "Removing profile directory: $0"
      RMDir /r "$0"
    done:
!macroend
