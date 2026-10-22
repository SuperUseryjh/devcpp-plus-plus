param(
  [string]$Version = "1.13.2"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$target = Join-Path $repoRoot "tools\ninja"
$ninja = Join-Path $target "ninja.exe"

if (Test-Path $ninja) {
  Write-Host "ninja already exists: $ninja"
  & $ninja --version
  exit 0
}

$url = "https://github.com/ninja-build/ninja/releases/download/v$Version/ninja-win.zip"
$zip = Join-Path $env:TEMP "ninja-win-$Version.zip"
$extract = Join-Path $env:TEMP "ninja-$Version-extract"

Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $zip

if (Test-Path $extract) {
  Remove-Item $extract -Recurse -Force
}
Expand-Archive -Path $zip -DestinationPath $extract -Force

New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item (Join-Path $extract "ninja.exe") $ninja -Force

Write-Host "Installed ninja to $target"
& $ninja --version
