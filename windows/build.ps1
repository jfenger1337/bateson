# Build bateson.exe, and with -Install put it in %LOCALAPPDATA%\Programs\bateson with a Start menu entry.
# No Visual Studio: the .NET 10 SDK is all it needs (winget install Microsoft.DotNet.SDK.10).
# Windows runs no scripts out of the box, so start it as:
#   powershell -ExecutionPolicy Bypass -File windows\build.ps1 -Install
# -Uninstall takes the app away again: its folder, the Start menu entry and its entry at login.
param([switch]$Install, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$dest = Join-Path $env:LOCALAPPDATA 'Programs\bateson'
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'bateson.lnk'

function Stop-App {
  $running = Get-Process -Name bateson -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dest\*" }
  $running | Stop-Process -Force
  $running | Wait-Process -Timeout 5 -ErrorAction SilentlyContinue
  return [bool]$running
}

if ($Uninstall) {
  Stop-App | Out-Null
  Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $shortcut -Force -ErrorAction SilentlyContinue
  Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'bateson app' -ErrorAction SilentlyContinue
  Remove-Item 'HKCU:\Software\Classes\AppUserModelId\bateson' -Recurse -ErrorAction SilentlyContinue
  Write-Output 'Removed the bateson app'
  exit 0
}

$rid = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
if (Test-Path build) { Remove-Item build -Recurse -Force }
dotnet publish bateson.csproj -c Release -r $rid --self-contained false -o build\bateson -nologo -v quiet
if ($LASTEXITCODE) { exit $LASTEXITCODE }

if ($Install) {
  $was = Stop-App
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  New-Item -ItemType Directory -Force $dest | Out-Null
  Copy-Item build\bateson\* $dest -Recurse
  $link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
  $link.TargetPath = Join-Path $dest 'bateson.exe'
  $link.WorkingDirectory = $dest
  $link.Save()
  # It was running: start the new one in its place.
  if ($was) { Start-Process (Join-Path $dest 'bateson.exe') }
  Write-Output "Installed $dest\bateson.exe (Start menu: bateson)"
} else {
  Write-Output 'Built windows\build\bateson\bateson.exe'
}
