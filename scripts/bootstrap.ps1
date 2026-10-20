# NodePilot Windows Bootstrap & Launcher
# Automatically detects, installs Node.js if missing, installs dependencies, builds, and launches NodePilot.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$rootDir = (Resolve-Path "$PSScriptRoot\..").Path
Set-Location $rootDir

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "                NodePilot Game Server Manager               " -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

function Get-NodeVersion {
    param([string]$ExecutablePath = "node")
    try {
        $ver = & $ExecutablePath -v 2>$null
        if ($ver -match '^v(\d+)\.(\d+)') {
            return [PSCustomObject]@{
                Full = $ver.Trim()
                Major = [int]$matches[1]
                Minor = [int]$matches[2]
            }
        }
    } catch { }
    return $null
}

# 1. Check if Node is available locally in .nodepilot/tools/node
$toolsNodeDir = Join-Path $rootDir ".nodepilot\tools\node"
if (Test-Path $toolsNodeDir) {
    $localNodeDirs = Get-ChildItem -Path $toolsNodeDir -Directory -Filter "node-v*" | Sort-Object Name -Descending
    foreach ($dir in $localNodeDirs) {
        $candidateExe = Join-Path $dir.FullName "node.exe"
        if (Test-Path $candidateExe) {
            $env:Path = "$($dir.FullName);$($env:Path)"
            break
        }
    }
}

# 2. Check if system Node meets version >= 20
$nodeVer = Get-NodeVersion
$needsInstall = ($null -eq $nodeVer) -or ($nodeVer.Major -lt 20)

if ($needsInstall) {
    if ($null -ne $nodeVer) {
        Write-Host "[NodePilot] Detected Node.js $($nodeVer.Full), but NodePilot requires Node.js 20 or newer." -ForegroundColor Yellow
    } else {
        Write-Host "[NodePilot] Node.js is not installed on this system." -ForegroundColor Yellow
    }
    Write-Host "[NodePilot] Installing Node.js LTS automatically..." -ForegroundColor Green
    Write-Host ""

    $installed = $false

    # Try winget first if available
    $wingetCmd = Get-Command "winget.exe" -ErrorAction SilentlyContinue
    if ($null -ne $wingetCmd) {
        Write-Host "[NodePilot] Attempting installation via winget..." -ForegroundColor Cyan
        try {
            $wingetProcess = Start-Process -FilePath "winget.exe" -ArgumentList "install", "OpenJS.NodeJS.LTS", "--silent", "--accept-package-agreements", "--accept-source-agreements" -NoNewWindow -Wait -PassThru
            if ($wingetProcess.ExitCode -eq 0) {
                # Refresh PATH from registry
                $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
                $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
                $env:Path = "$machinePath;$userPath"

                $nodeVer = Get-NodeVersion
                if ($null -ne $nodeVer -and $nodeVer.Major -ge 20) {
                    Write-Host "[NodePilot] Successfully installed Node.js $($nodeVer.Full) via winget!" -ForegroundColor Green
                    $installed = $true
                }
            }
        } catch {
            Write-Host "[NodePilot] winget installation encountered an error. Falling back to portable download..." -ForegroundColor Gray
        }
    }

    # Portable download fallback (requires no admin privileges)
    if (-not $installed) {
        Write-Host "[NodePilot] Downloading official portable Node.js LTS from nodejs.org..." -ForegroundColor Cyan
        
        $arch = if ([System.Environment]::Is64BitOperatingSystem) {
            if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
        } else {
            'win-x86'
        }

        try {
            # Find latest v22 LTS zip file
            $shasUrl = "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt"
            $shasContent = (Invoke-RestMethod -Uri $shasUrl -UseBasicParsing)
            $regex = "(node-v22\.\d+\.\d+-$arch\.zip)"
            $match = [regex]::Match($shasContent, $regex)

            if (-not $match.Success) {
                throw "Could not determine latest Node.js LTS zip for architecture $arch."
            }

            $zipName = $match.Groups[1].Value
            $downloadUrl = "https://nodejs.org/dist/latest-v22.x/$zipName"
            
            New-Item -ItemType Directory -Path $toolsNodeDir -Force | Out-Null
            $tempZip = Join-Path $toolsNodeDir $zipName

            Write-Host "[NodePilot] Downloading $zipName..." -ForegroundColor Cyan
            [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12 -bor [System.Net.SecurityProtocolType]::Tls13
            Invoke-WebRequest -Uri $downloadUrl -OutFile $tempZip -UseBasicParsing

            Write-Host "[NodePilot] Extracting Node.js into .nodepilot/tools/node..." -ForegroundColor Cyan
            Expand-Archive -Path $tempZip -DestinationPath $toolsNodeDir -Force
            Remove-Item -Path $tempZip -Force -ErrorAction SilentlyContinue

            $extractedDir = Join-Path $toolsNodeDir ($zipName -replace '\.zip$', '')
            $env:Path = "$extractedDir;$($env:Path)"

            # Also register to user Path for convenience in other terminals
            try {
                $currentUserPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
                if ($currentUserPath -notlike "*$extractedDir*") {
                    [System.Environment]::SetEnvironmentVariable("Path", "$extractedDir;$currentUserPath", "User")
                }
            } catch { }

            $nodeVer = Get-NodeVersion
            if ($null -ne $nodeVer) {
                Write-Host "[NodePilot] Node.js $($nodeVer.Full) portable setup complete!" -ForegroundColor Green
                $installed = $true
            } else {
                throw "Node.js executable could not be verified after extraction."
            }
        } catch {
            Write-Host "[NodePilot] ERROR: Failed to install Node.js automatically: $_" -ForegroundColor Red
            Write-Host "[NodePilot] Please install Node.js manually from https://nodejs.org (v20 or v22 recommended)." -ForegroundColor Yellow
            exit 1
        }
    }
} else {
    Write-Host "[NodePilot] Found Node.js $($nodeVer.Full) on PATH." -ForegroundColor Green
}

# 3. Check dependencies (node_modules)
if (-not (Test-Path "$rootDir\node_modules")) {
    Write-Host ""
    Write-Host "[NodePilot] Installing application dependencies (npm install)..." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[NodePilot] Failed to install dependencies. Exiting." -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

# 4. Check build
if (-not (Test-Path "$rootDir\server\dist") -or -not (Test-Path "$rootDir\client\dist")) {
    Write-Host ""
    Write-Host "[NodePilot] Building NodePilot client and server (npm run build)..." -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[NodePilot] Build failed. Exiting." -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

# 5. Launch NodePilot
Write-Host ""
Write-Host "[NodePilot] Starting NodePilot dashboard..." -ForegroundColor Green
Write-Host "[NodePilot] Press Ctrl+C in this terminal to stop the server." -ForegroundColor Gray
Write-Host ""

npm start
