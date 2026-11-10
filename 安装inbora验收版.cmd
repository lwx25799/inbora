@echo off
setlocal
set "INBORA_INSTALLER=%~dp0.local\delivery\poc-0.3.5-22bd6e1\inbora_0.3.5_x64-setup.exe"
if not exist "%INBORA_INSTALLER%" (
  echo Installer file is missing. Keep this launcher inside D:\Inbora.
  pause
  exit /b 1
)
powershell.exe -NoProfile -NonInteractive -Command "if ((Get-FileHash -LiteralPath $env:INBORA_INSTALLER -Algorithm SHA256).Hash -ne 'E19DBD580EB2EB884FF39AE76F984631C489383AC0CE85899E274708DBE12687') { exit 1 }"
if errorlevel 1 (
  echo Installer verification failed. Installation was not started.
  pause
  exit /b 1
)
start "" /wait "%INBORA_INSTALLER%"
exit /b %errorlevel%
