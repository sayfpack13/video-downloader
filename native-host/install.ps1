# Registers the native messaging host for Chrome on Windows.
# Usage: .\install.ps1 -ExtensionId "abcdefghijklmnopqrstuvwxyzabcdef"

param(
    [Parameter(Mandatory = $true)]
    [string]$ExtensionId
)

$ErrorActionPreference = "Stop"
$HostDir = $PSScriptRoot
$BatPath = (Resolve-Path (Join-Path $HostDir "run_host.bat")).Path
$ManifestOut = Join-Path $HostDir "com.waelacademy.downloader.installed.json"

if (-not (Test-Path $BatPath)) {
    Write-Error "run_host.bat not found in $HostDir"
}

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Error "python not found on PATH. Install Python 3 and retry."
}

$manifestObj = @{
    name = "com.waelacademy.downloader"
    description = "Wael Academy ffmpeg download host"
    path = $BatPath
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
}

$json = $manifestObj | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($ManifestOut, $json)

$regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.waelacademy.downloader"
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name "(default)" -Value $ManifestOut

Write-Host "Native host installed."
Write-Host "  Registry: $regPath"
Write-Host "  Manifest: $ManifestOut"
Write-Host "  Host path:  $BatPath"
Write-Host "  Extension ID: $ExtensionId"
Write-Host ""
Write-Host "Reload the extension in chrome://extensions, then open the side panel."
