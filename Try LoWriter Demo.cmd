@echo off
title LoWriter Demo - close this window to quit
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0LoWriter.ps1" demo
if errorlevel 1 pause
