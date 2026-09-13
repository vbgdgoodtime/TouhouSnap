@echo off
rem ============================================================
rem  tools\publish.cmd  --  launcher for publish.ps1
rem
rem  Why this wrapper exists:
rem    1) This machine runs Windows PowerShell 5.1 (no pwsh 7 installed)
rem       and its execution policy is Restricted, so running a .ps1 file
rem       directly is blocked. -ExecutionPolicy Bypass applies to THIS
rem       process only; it does not change any system setting.
rem    2) publish.ps1 is written to work on both 5.1 and 7.
rem
rem  Usage (arguments are passed straight through):
rem    tools\publish.cmd                     deploy for real
rem    tools\publish.cmd -SkipDeploy         stage + report only
rem    tools\publish.cmd -ProjectName foo    override project name
rem ============================================================

setlocal
set "PSEXE=powershell"
where pwsh >nul 2>nul && set "PSEXE=pwsh"
"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1" %*
exit /b %ERRORLEVEL%
