@echo off
title LoWriter - close this window to quit
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0LoWriter.ps1" start
if errorlevel 1 pause
