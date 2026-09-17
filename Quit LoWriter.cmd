@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0LoWriter.ps1" quit
if errorlevel 1 pause
