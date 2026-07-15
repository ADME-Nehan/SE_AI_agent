@echo off
cd /d "%~dp0"
echo Installing optional Google Stitch SDK...
npm install @google/stitch-sdk --registry=https://registry.npmjs.org/
echo.
echo Done. Add STITCH_API_KEY to .env.local, then run node server.js
pause
