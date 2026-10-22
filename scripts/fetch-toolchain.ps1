$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

& (Join-Path $PSScriptRoot "fetch-clangd.ps1")
& (Join-Path $PSScriptRoot "fetch-cmake.ps1")
& (Join-Path $PSScriptRoot "fetch-ninja.ps1")

Write-Host ""
Write-Host "Toolchain ready:"
Write-Host "  clangd: tools\clangd\bin\clangd.exe"
Write-Host "  cmake:  tools\cmake\bin\cmake.exe"
Write-Host "  ninja:  tools\ninja\ninja.exe"
