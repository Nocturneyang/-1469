@echo off
cd /d "%~dp0"

echo.
echo  WhatsApp Monitor v2.0
echo  ==================================

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [Info] Node.js not found. Trying to install automatically...
    where winget >nul 2>&1
    if %errorlevel% equ 0 (
        echo  [Info] Installing Node.js LTS via winget, please wait...
        winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
        if %errorlevel% neq 0 (
            echo  [Error] winget install failed. Please install manually: https://nodejs.org
            pause
            exit /b 1
        )
        :: Refresh PATH so node is available in this session
        for /f "tokens=*" %%i in ('powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\"PATH\",\"Machine\") + \";\" + [System.Environment]::GetEnvironmentVariable(\"PATH\",\"User\")"') do set "PATH=%%i"
        where node >nul 2>&1
        if %errorlevel% neq 0 (
            echo  [OK] Node.js installed! Please re-run start.bat to continue.
            pause
            exit /b 0
        )
        echo  [OK] Node.js installed successfully.
    ) else (
        echo  [Error] winget not available. Please install Node.js manually:
        echo          https://nodejs.org/en/download  (Download the LTS installer)
        start "" "https://nodejs.org/en/download"
        pause
        exit /b 1
    )
)
for /f "tokens=*" %%v in ('node -v') do echo  [OK] Node.js %%v


:: Install dependencies if needed
if not exist "node_modules\express" (
    echo  [Info] Installing dependencies, please wait...
    call npm install
    if %errorlevel% neq 0 (
        echo  [Error] npm install failed
        pause
        exit /b 1
    )
    echo  [OK] Dependencies installed
)

:: Create .env if missing
if not exist ".env" (
    echo  [Info] .env not found, generating from .env.example...
    copy .env.example .env >nul
    echo  [Warn] Please edit .env to fill in your API keys if necessary.
)

:: Start node in a minimized background window
echo  [Info] Starting server in background...
start "WhatsApp Monitor" /min cmd /c "node index.js"

echo  [Info] Waiting for server to be ready...

:: Poll using built-in curl (Windows 10+)
set /a retries=0
:wait_loop
set /a retries+=1
if %retries% gtr 30 (
    echo  [Warn] Timeout. Open manually: http://localhost:3000
    goto open_browser
)
curl -s -o nul http://localhost:3000 2>nul
if %errorlevel% equ 0 goto server_ready
timeout /t 1 /nobreak >nul
goto wait_loop

:server_ready
echo  [OK] Server ready!

:open_browser
start "" "http://localhost:3000"

echo.
echo  ==================================
echo  Program is running (check taskbar)
echo  URL:  http://localhost:3000
echo  Stop: close the WhatsApp Monitor window in taskbar
echo  ==================================
echo.
pause
