:: SPDX-License-Identifier: GPL-3.0-or-later
:: install-plugin.bat - installs the RoLink Studio plugin (third-party MCP path).
:: Copies studio-plugin\RoLink.lua into Roblox Studio's Plugins folder so the
:: 140 registry tools execute inside Studio via the bridge's :3001 queue.
@echo off
setlocal
cd /d "%~dp0"

if not exist "%~dp0studio-plugin\RoLink.lua" (
    echo   ERROR: studio-plugin\RoLink.lua not found next to this file.
    echo   Extract the WHOLE download, then run this again.
    pause
    exit /b 1
)

set "PLUGINDIR=%LOCALAPPDATA%\Roblox\Plugins"
if not exist "%PLUGINDIR%" mkdir "%PLUGINDIR%" >nul 2>nul

REM Studio locks the plugin file while open: installing now keeps OLD bytes
REM with no visible error, then Studio reports mystery syntax errors from the
REM stale copy. Refuse a hot install instead of failing silently.
tasklist /FI "IMAGENAME eq RobloxStudioBeta.exe" 2>nul | findstr /i "RobloxStudioBeta.exe" >nul
if not errorlevel 1 (
    echo.
    echo   ############################################################
    echo   ##  QUIT ROBLOX STUDIO FIRST - it is running right now.   ##
    echo   ##  Installing now would leave the OLD plugin in place.   ##
    echo   ##  Close EVERY Studio window, then run this file again.  ##
    echo   ############################################################
    echo.
    pause
    exit /b 2
)

REM Exactly ONE plugin copy may exist: two copies poll the same queue and
REM fight over claims (one executes, the other reports confusing duplicates).
REM Remove known strays from manual installs/renames/duplicate downloads
REM (never touch other files).
for %%F in ("%PLUGINDIR%\user_RoLink.lua" "%PLUGINDIR%\RoLink*.lua.bak" "%PLUGINDIR%\RoLink (*).lua" "%PLUGINDIR%\RoLink - Copy.lua") do (
    if exist "%%~F" (
        echo   Removing stray duplicate: %%~nxF
        del "%%~F" >nul 2>nul
    )
)
copy /y "%~dp0studio-plugin\RoLink.lua" "%PLUGINDIR%\RoLink.lua" >nul
if errorlevel 1 (
    echo   ERROR: could not copy into %PLUGINDIR%.
    echo   Copy studio-plugin\RoLink.lua there by hand.
    pause
    exit /b 1
)

REM Byte-compare: a locked/shadowed destination can keep old bytes even when
REM copy reports success. Sizes must match or the install did not take.
for %%A in ("%~dp0studio-plugin\RoLink.lua") do set "SRCBYTES=%%~zA"
for %%A in ("%PLUGINDIR%\RoLink.lua") do set "DSTBYTES=%%~zA"
if not "%SRCBYTES%"=="%DSTBYTES%" (
    echo   ERROR: installed file is %DSTBYTES% bytes but source is %SRCBYTES% bytes.
    echo   A stale copy is shadowing the install - delete every *RoLink*.lua
    echo   in %PLUGINDIR% by hand, then run this again with Studio closed.
    pause
    exit /b 3
)
echo   INSTALL OK (%DSTBYTES% bytes, matches source).

REM Final single-copy check: Studio loads every match, so more than one is
REM a broken install even if each file alone is fine.
set "DUPCOUNT=0"
for %%F in ("%PLUGINDIR%\*RoLink*.lua") do if exist "%%~F" set /a DUPCOUNT+=1
if not "%DUPCOUNT%"=="1" (
    echo   WARNING: %DUPCOUNT% *RoLink*.lua files in %PLUGINDIR% - Studio loads
    echo   ALL of them and they fight. Keep only RoLink.lua, delete the rest.
)

echo.
echo   RoLink plugin installed to:
echo     %PLUGINDIR%\RoLink.lua
echo.
echo   TWO MORE STEPS INSIDE ROBLOX STUDIO (once per place):
echo     1. Open your place, press View ^> Command Bar, run:
echo          game:GetService("HttpService").HttpEnabled = true
echo        (lets the plugin reach the bridge queue on :3001)
echo     2. Restart Studio if it was open. A "RoLink" toolbar button
echo        appears, Output shows "RoLink 2.7.0 loaded [repo copy]",
echo        and the bridge prints "plugin polling" when it connects.
echo        No banner = the old copy is still installed; redo this
echo        file with Studio fully closed.
echo.
echo   Verify: start.bat shows "Studio queue :3001 up - plugin polling".
pause
