@echo off
cd /d "%~dp0"
echo.
echo  [Info] Stopping WhatsApp Monitor...

:: Find and kill the process on port 3000
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING"') do (
    echo  [OK] Killing process PID %%p
    taskkill /PID %%p /F >nul 2>&1
)

echo  [OK] Done.
echo.
pause
