@echo off
setlocal
cd /d "%~dp0"
if exist ".local\start-development.cmd" (
  call ".local\start-development.cmd"
) else (
  call pnpm desktop:dev
)
exit /b %errorlevel%
