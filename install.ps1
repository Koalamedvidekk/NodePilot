# NodePilot One-Line Online Installer
# Usage: irm https://raw.githubusercontent.com/Koalamedvidekk/NodePilot/main/install.ps1 | iex

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "                NodePilot Game Server Manager               " -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

function Test-NodePilotInstallation([string]$directory) {
    $manifest = Join-Path $directory 'package.json'
    $launcher = Join-Path $directory 'scripts\bootstrap.ps1'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf) -or
        -not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        return $false
    }
    try {
        return (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).name -eq 'nodepilot'
    } catch {
        return $false
    }
}

$currentLocation = Get-Location
if ($currentLocation.Provider.Name -eq 'FileSystem' -and (Test-NodePilotInstallation $currentLocation.ProviderPath)) {
    $targetDir = $currentLocation.ProviderPath
} else {
    $defaultTarget = Join-Path $HOME 'NodePilot'
    $profileDrive = [IO.Path]::GetPathRoot($defaultTarget)
    $destinations = @($defaultTarget)
    foreach ($drive in ([IO.DriveInfo]::GetDrives() | Sort-Object Name)) {
        if ($drive.Name -ne $profileDrive -and $drive.DriveType -in @('Fixed', 'Removable') -and $drive.IsReady) {
            $destinations += [IO.Path]::Combine($drive.Name, 'NodePilot')
        }
    }

    Write-Host 'Choose a drive for NodePilot:' -ForegroundColor Cyan
    for ($index = 0; $index -lt $destinations.Count; $index++) {
        $label = if ($index -eq 0) { ' (default)' } else { '' }
        Write-Host ('  [{0}] {1}{2}' -f ($index + 1), $destinations[$index], $label)
    }

    while ($true) {
        $choice = ([string](Read-Host 'Enter a number, press Enter for the default, or Q to cancel')).Trim()
        if ($choice -eq 'q') { return }
        if (-not $choice) { $choice = '1' }
        $number = 0
        if (-not [int]::TryParse($choice, [ref]$number) -or $number -lt 1 -or $number -gt $destinations.Count) {
            Write-Host 'Choose a number from the list.' -ForegroundColor Yellow
            continue
        }
        $targetDir = $destinations[$number - 1]
        if ((Test-Path -LiteralPath $targetDir) -and -not (Test-NodePilotInstallation $targetDir)) {
            Write-Host "The path already exists and is unavailable for installation: $targetDir" -ForegroundColor Yellow
            continue
        }
        break
    }
}

if (-not (Test-NodePilotInstallation $targetDir)) {
    $targetParent = [IO.Path]::GetDirectoryName($targetDir)
    # Stage beside the destination so a ZIP installation can be renamed on the selected drive.
    $stageName = '.nodepilot-install-' + [guid]::NewGuid().ToString('N')
    $stageDirectory = Join-Path $targetParent $stageName
    $stagedSource = Join-Path $stageDirectory 'NodePilot-main'
    try {
        New-Item -ItemType Directory -Path $stageDirectory | Out-Null
    } catch {
        throw "Could not write to $targetParent. Run the installer again and choose a writable drive. $($_.Exception.Message)"
    }

    Write-Host "[NodePilot] Installing to $targetDir" -ForegroundColor Cyan
    Write-Host "[NodePilot] Downloading NodePilot repository..." -ForegroundColor Cyan
    try {
        $gitCmd = Get-Command 'git.exe' -ErrorAction SilentlyContinue
        if ($null -ne $gitCmd) {
            & $gitCmd.Source clone https://github.com/Koalamedvidekk/NodePilot.git $stagedSource
            if ($LASTEXITCODE -ne 0) { throw "Git could not download NodePilot (exit code $LASTEXITCODE)." }
        } else {
            $zipUrl = 'https://github.com/Koalamedvidekk/NodePilot/archive/refs/heads/main.zip'
            $tempZip = Join-Path $stageDirectory 'NodePilot-main.zip'
            Invoke-WebRequest -Uri $zipUrl -OutFile $tempZip -UseBasicParsing
            Expand-Archive -LiteralPath $tempZip -DestinationPath $stageDirectory
        }
        if (-not (Test-NodePilotInstallation $stagedSource)) { throw 'The download did not contain a complete NodePilot installation.' }
        [IO.Directory]::Move($stagedSource, $targetDir)
    } finally {
        $stage = Get-Item -LiteralPath $stageDirectory -Force -ErrorAction SilentlyContinue
        if ($stage -and $stage.FullName -eq $stageDirectory -and $stage.Name -eq $stageName -and
            -not ($stage.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Remove-Item -LiteralPath $stage.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

Set-Location -LiteralPath $targetDir
& (Join-Path $targetDir 'scripts\bootstrap.ps1')
