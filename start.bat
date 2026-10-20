@echo off
setlocal enabledelayedexpansion
title NodePilot Launcher
cd /d "%~dp0"

echo [NodePilot] Checking environment and launching...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1"
if %errorlevel% neq 0 (
    echo.
    echo [NodePilot] Launcher exited with error code %errorlevel%.
    pause
)
