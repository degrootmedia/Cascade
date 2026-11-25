!macro customInstall
  DetailPrint "Checking for FFmpeg dependency..."
  nsExec::ExecToLog 'cmd.exe /C where ffmpeg'
  Pop $0
  ${If} $0 != 0
    DetailPrint "FFmpeg not detected. Installing Gyan.FFmpeg via winget..."
    nsExec::ExecToLog 'cmd.exe /C winget install Gyan.FFmpeg --accept-package-agreements --accept-source-agreements --silent'
    Pop $0
    ${If} $0 == 0
      DetailPrint "FFmpeg installed successfully."
    ${Else}
      DetailPrint "Note: Optional FFmpeg auto-install skipped or requires elevation ($0)."
    ${EndIf}
  ${Else}
    DetailPrint "FFmpeg is already installed."
  ${EndIf}
!macroend
