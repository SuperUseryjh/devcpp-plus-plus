$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

$missing = @()
if (-not (Test-Path "tools\clangd\bin\clangd.exe")) { $missing += "clangd" }
if (-not (Test-Path "tools\cmake\bin\cmake.exe")) { $missing += "cmake" }
if (-not (Test-Path "tools\ninja\ninja.exe")) { $missing += "ninja" }

if ($missing.Count -gt 0) {
  Write-Host "Missing local toolchain: $($missing -join ', ')"
  Write-Host "Running scripts\fetch-toolchain.ps1"
  & (Join-Path $PSScriptRoot "fetch-toolchain.ps1")
}

npm run tauri dev
