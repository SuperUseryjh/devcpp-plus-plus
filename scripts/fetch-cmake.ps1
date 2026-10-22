param(
  [string]$Version = "4.2.0"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$target = Join-Path $repoRoot "tools\cmake"
$cmake = Join-Path $target "bin\cmake.exe"

if (Test-Path $cmake) {
  Write-Host "cmake already exists: $cmake"
  & $cmake --version
  exit 0
}

$url = "https://github.com/Kitware/CMake/releases/download/v$Version/cmake-$Version-windows-x86_64.zip"
$zip = Join-Path $env:TEMP "cmake-$Version-windows-x86_64.zip"
$extract = Join-Path $env:TEMP "cmake-$Version-extract"

Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $zip

if (Test-Path $extract) {
  Remove-Item $extract -Recurse -Force
}
Expand-Archive -Path $zip -DestinationPath $extract -Force

$source = Join-Path $extract "cmake-$Version-windows-x86_64"
if (-not (Test-Path $source)) {
  throw "Unexpected archive layout: $source not found"
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
if (Test-Path $target) {
  Remove-Item $target -Recurse -Force
}
Move-Item $source $target

Write-Host "Installed cmake to $target"
& $cmake --version | Select-Object -First 1
