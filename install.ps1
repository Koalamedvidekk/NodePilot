# NodePilot One-Line Online Installer
# Usage: irm https://raw.githubusercontent.com/Koalamedvidekk/NodePilot/main/install.ps1 | iex

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "                NodePilot Game Server Manager               " -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

$targetDir = Join-Path $HOME "NodePilot"
if (Test-Path "package.json") {
    $targetDir = (Get-Location).Path
} elseif (-not (Test-Path $targetDir)) {
    Write-Host "[NodePilot] Downloading NodePilot repository..." -ForegroundColor Cyan
    
    $gitCmd = Get-Command "git.exe" -ErrorAction SilentlyContinue
    if ($null -ne $gitCmd) {
        git clone https://github.com/Koalamedvidekk/NodePilot.git $targetDir
    } else {
        # Download ZIP
        $zipUrl = "https://github.com/Koalamedvidekk/NodePilot/archive/refs/heads/main.zip"
        $tempZip = Join-Path $env:TEMP "NodePilot-main.zip"
        Invoke-WebRequest -Uri $zipUrl -OutFile $tempZip -UseBasicParsing
        Expand-Archive -Path $tempZip -DestinationPath $env:TEMP -Force
        Remove-Item $tempZip -Force -ErrorAction SilentlyContinue
        Move-Item (Join-Path $env:TEMP "NodePilot-main") $targetDir
    }
}

Set-Location $targetDir
& (Join-Path $targetDir "scripts\bootstrap.ps1")
