@echo off
setlocal
title YuanPlan - Allow inbound access

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

rem Read HTTP_PORT from deploy\.env so the firewall rule matches the running app.
set "PORT="
set "ENVFILE=%~dp0.env"
if exist "%ENVFILE%" (
  for /f "usebackq tokens=1,* delims==" %%a in ("%ENVFILE%") do (
    if /i "%%a"=="HTTP_PORT" set "PORT=%%b"
  )
)
if not defined PORT set "PORT=18420"

set "RULENAME=YuanPlan LAN HTTP (%PORT%)"

echo.
echo === YuanPlan: allow inbound TCP %PORT% ===
echo.
echo This machine's IPv4 addresses:
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress"
echo.
echo Removing legacy HTTPS rule (if any)...
powershell -NoProfile -Command "Get-NetFirewallRule -DisplayName 'YuanPlan LAN HTTPS (443)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue"
echo Adding firewall rule "%RULENAME%"...

powershell -NoProfile -Command "Get-NetFirewallRule -DisplayName '%RULENAME%' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue"
powershell -NoProfile -Command "New-NetFirewallRule -DisplayName '%RULENAME%' -Direction Inbound -Protocol TCP -LocalPort %PORT% -Action Allow -Profile Any | Out-Null"

if %errorlevel% equ 0 (
  echo.
  echo [OK] Rule added.
  echo      Colleagues can now open http://THIS-MACHINE-IP:%PORT% in a browser.
  echo.
) else (
  echo.
  echo [FAILED] Could not add the rule. Please make sure you approved
  echo          the administrator prompt when Windows asked.
  echo.
)

echo Current status of the rule:
powershell -NoProfile -Command "Get-NetFirewallRule -DisplayName '%RULENAME%' -ErrorAction SilentlyContinue | Format-Table DisplayName,Enabled,Direction,Action,Profile -AutoSize"

echo.
pause
