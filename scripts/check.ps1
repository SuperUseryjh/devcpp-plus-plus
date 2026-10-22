$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host "== frontend build =="
npm run build

Write-Host "== rust tests =="
cargo test --manifest-path src-tauri/Cargo.toml
