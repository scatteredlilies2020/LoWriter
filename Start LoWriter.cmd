@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0LoWriter.ps1" start
if errorlevel 1 pause
