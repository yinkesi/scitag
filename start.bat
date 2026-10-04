@echo off
rem SciTag 启动器：独立进程跑服务（不随终端关闭），Chrome 优先打开
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo 未找到 node，请先安装 Node.js 18+ & pause & exit /b 1)

rem 已在跑就不重复起
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8093/api/health' -TimeoutSec 2; exit 0 } catch { exit 1 }" && goto :open

echo 正在启动 SciTag ...
powershell -NoProfile -Command "Start-Process -WindowStyle Hidden node -ArgumentList 'server.js' -WorkingDirectory '%~dp0'"
timeout /t 2 /nobreak >nul

:open
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" (start "" "%CHROME%" "http://127.0.0.1:8093") else (start "" "http://127.0.0.1:8093")
endlocal
