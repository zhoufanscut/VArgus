@echo off
setlocal
set "VARGUS_CLI_MAIN=1"
node "%~dp0..\src\cli.ts" %*
exit /b %errorlevel%
