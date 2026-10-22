$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Test-Path "tools\clangd\bin\clangd.exe")) {
  Write-Host "clangd not found; running scripts\fetch-clangd.ps1"
  & (Join-Path $PSScriptRoot "fetch-clangd.ps1")
}

npm run tauri dev
