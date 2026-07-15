@echo off
cls
echo Starting AI Agent Terminal Firebase...
echo.
node -v
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js LTS first.
  pause
  exit /b 1
)
echo.
node server.js
pause
