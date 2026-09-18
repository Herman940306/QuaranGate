@echo off
setlocal
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "%~dp0QuaranGate-Setup.ps1" %*
exit /b %ERRORLEVEL%
