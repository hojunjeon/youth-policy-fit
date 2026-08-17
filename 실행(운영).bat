@echo off
setlocal
cd /d "%~dp0"
title chaebi - production server

echo ============================================
echo   chaebi - Next.js production launcher
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found on this PC.
    echo Please install Node.js LTS from https://nodejs.org and run this again.
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js found:
node --version
echo [OK] npm found:
call npm --version
echo.

if not exist "node_modules" (
    echo [INFO] node_modules not found. Running npm install...
    echo         This may take a few minutes on first run.
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed. Please check the messages above.
        pause
        exit /b 1
    )
    echo.
    echo [OK] npm install finished.
    echo.
)

echo [INFO] Building production bundle. This can take a minute...
echo.
call npm run build
if errorlevel 1 (
    echo.
    echo [ERROR] npm run build failed. Please check the messages above.
    pause
    exit /b 1
)

echo.
echo [INFO] Build finished. Starting the production server. The browser
echo        will open automatically at http://localhost:3000 in a few
echo        seconds.
echo [INFO] If port 3000 is already in use, the production server will
echo        fail to start (EADDRINUSE). Close the other process using
echo        port 3000 first, then run this again.
echo [INFO] Close this window to stop the server.
echo.

start "" cmd /c "ping -n 6 127.0.0.1 >nul & start http://localhost:3000"

call npm run start
if errorlevel 1 (
    echo.
    echo [ERROR] The production server failed to start or exited with an error.
    echo         Port 3000 may already be in use - close the other process and try again.
    pause
    exit /b 1
)

echo.
echo [INFO] Production server stopped.
pause
