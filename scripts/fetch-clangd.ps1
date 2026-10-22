param(
  [string]$Version = "20.1.8"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$target = Join-Path $repoRoot "tools\clangd"
$clangd = Join-Path $target "bin\clangd.exe"

if (Test-Path $clangd) {
  Write-Host "clangd already exists: $clangd"
  & $clangd --version
  exit 0
}

$url = "https://github.com/clangd/clangd/releases/download/$Version/clangd-windows-$Version.zip"
$zip = Join-Path $env:TEMP "clangd-windows-$Version.zip"
$extract = Join-Path $env:TEMP "clangd-windows-$Version-extract"

Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $zip

if (Test-Path $extract) {
  Remove-Item $extract -Recurse -Force
}
Expand-Archive -Path $zip -DestinationPath $extract -Force

$source = Join-Path $extract "clangd_$Version"
if (-not (Test-Path $source)) {
  throw "Unexpected archive layout: $source not found"
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
if (Test-Path $target) {
  Remove-Item $target -Recurse -Force
}
Move-Item $source $target

Write-Host "Installed clangd to $target"
& $clangd --version
