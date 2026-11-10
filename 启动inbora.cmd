@echo off
setlocal
cd /d "%~dp0"
where pnpm >nul 2>&1
if errorlevel 1 (
  if not exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd" goto missing_pnpm
  set "PATH=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback;%PATH%"
)
if exist ".local\start-development.cmd" (
  call ".local\start-development.cmd"
) else (
  call pnpm desktop:dev
)
set "INBORA_START_EXIT=%errorlevel%"
if not "%INBORA_START_EXIT%"=="0" (
  echo inbora did not start. Keep this window open and report the error above.
  pause
)
exit /b %INBORA_START_EXIT%

:missing_pnpm
echo inbora could not find pnpm. The existing development tool is unavailable.
pause
exit /b 9009
