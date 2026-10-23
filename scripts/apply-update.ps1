# NodePilot detached updater for Windows.
# It is deliberately conservative: it never kills the parent process, only accepts a
# verified staging directory created by NodePilot, and restores the previous application
# files when dependency installation or the build fails.
param(
    [Parameter(Mandatory = $true)]
    [int]$ParentPid,

    [Parameter(Mandatory = $true)]
    [string]$StagedDir,

    [Parameter(Mandatory = $true)]
    [string]$TargetDir,

    [Parameter(Mandatory = $true)]
    [string]$UpdateRoot,

    [Parameter(Mandatory = $true)]
    [string]$BackupDir
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-AbsolutePath {
    param([Parameter(Mandatory = $true)][string]$PathValue)
    return [System.IO.Path]::GetFullPath($PathValue)
}

function Assert-ChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Child,
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Description
    )
    $normalizedRoot = $Root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if (-not $Child.StartsWith($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Description is outside its allowed directory."
    }
}

function Write-UpdateLog {
    param([Parameter(Mandatory = $true)][string]$Message)
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    Write-Host $line
    Add-Content -LiteralPath $script:LogFile -Value $line -Encoding utf8
}

function Test-SafeRelativePath {
    param([Parameter(Mandatory = $true)][string]$RelativePath)
    if (
        [string]::IsNullOrWhiteSpace($RelativePath) -or
        $RelativePath -match '[\x00-\x1F\x7F]' -or
        $RelativePath.Contains('\') -or
        $RelativePath.StartsWith('/') -or
        $RelativePath -match '^[A-Za-z]:' -or
        $RelativePath -match '(^|/)(\.|\.\.)(/|$)'
    ) {
        throw "Release manifest contains an unsafe path."
    }
    $parts = $RelativePath.Split('/')
    if ($parts.Count -eq 0 -or @($parts | Where-Object { $_.Length -eq 0 }).Count -gt 0) {
        throw "Release manifest contains an unsafe path."
    }
    if (@($parts | Where-Object { @('.nodepilot', '.git', 'node_modules', '.env') -contains $_.ToLowerInvariant() }).Count -gt 0) {
        throw "Release manifest attempts to overwrite protected local data."
    }
}

function Get-ManifestFiles {
    param([Parameter(Mandatory = $true)][string]$SourceDirectory)
    $manifestPath = Join-Path $SourceDirectory 'nodepilot-release.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Release manifest is missing."
    }
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    } catch {
        throw "Release manifest is invalid."
    }
    if ($manifest.schemaVersion -ne 1 -or $null -eq $manifest.files -or $manifest.files.Count -lt 1) {
        throw "Release manifest has an unsupported format."
    }

    $files = @()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in @($manifest.files)) {
        if ($entry -isnot [string]) {
            throw "Release manifest contains a non-string path."
        }
        Test-SafeRelativePath -RelativePath $entry
        if (-not $seen.Add($entry)) {
            throw "Release manifest contains duplicate paths."
        }
        $filePath = Get-AbsolutePath (Join-Path $SourceDirectory ($entry.Replace('/', [System.IO.Path]::DirectorySeparatorChar)))
        Assert-ChildPath -Child $filePath -Root $SourceDirectory -Description 'Manifest file'
        if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
            throw "Release package is missing $entry."
        }
        $files += $entry
    }
    foreach ($required in @(
        'package.json',
        'package-lock.json',
        'server/index.ts',
        'scripts/bootstrap.ps1',
        'scripts/bootstrap.sh',
        'scripts/apply-update.ps1',
        'scripts/apply-update.sh',
        'start.bat',
        'start.sh'
    )) {
        if (-not ($files -contains $required)) {
            throw "Release package is missing required file $required."
        }
    }

    $expected = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $files) { [void]$expected.Add($file) }
    foreach ($item in Get-ChildItem -LiteralPath $SourceDirectory -Force -Recurse) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Release package contains a symbolic link or reparse point."
        }
        if ($item.PSIsContainer) { continue }
        $relative = $item.FullName.Substring($SourceDirectory.Length).TrimStart('\', '/').Replace('\', '/')
        if ($relative -eq 'nodepilot-release.json') { continue }
        if (-not $expected.Contains($relative)) {
            throw "Release package contains an unlisted file: $relative."
        }
    }
    return $files
}

function Get-FileHashOrEmpty {
    param([Parameter(Mandatory = $true)][string]$PathValue)
    if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) { return '' }
    return (Get-FileHash -LiteralPath $PathValue -Algorithm SHA256).Hash
}

function Invoke-Npm {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $npm) { $npm = Get-Command npm -ErrorAction Stop }
    & $npm.Source @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

$target = Get-AbsolutePath $TargetDir
$updateRoot = Get-AbsolutePath $UpdateRoot
$staged = Get-AbsolutePath $StagedDir
$backup = Get-AbsolutePath $BackupDir
$stagingRoot = Get-AbsolutePath (Join-Path $updateRoot 'staged')
$backupRoot = Get-AbsolutePath (Join-Path $updateRoot 'backups')
Assert-ChildPath -Child $staged -Root $stagingRoot -Description 'Staged update'
Assert-ChildPath -Child $backup -Root $backupRoot -Description 'Backup directory'
if (-not (Test-Path -LiteralPath $staged -PathType Container)) { throw 'The staged update directory does not exist.' }
if (-not (Test-Path -LiteralPath (Join-Path $target 'package.json') -PathType Leaf)) { throw 'The target is not a NodePilot installation.' }
if ($target.Length -lt 4) { throw 'Refusing to update an unsafe target path.' }
$normalizedUpdateRoot = $updateRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
if ($target.Equals($updateRoot, [System.StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($normalizedUpdateRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The installation directory cannot be inside NodePilot update storage.'
}

New-Item -ItemType Directory -Path $updateRoot -Force | Out-Null
$script:LogFile = Join-Path $updateRoot 'update.log'
Write-UpdateLog "Updater started for NodePilot process $ParentPid."

$deadline = [DateTime]::UtcNow.AddSeconds(60)
while ([DateTime]::UtcNow -lt $deadline) {
    $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    if ($null -eq $parent -or $parent.HasExited) { break }
    Start-Sleep -Milliseconds 500
}
$parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
if ($null -ne $parent -and -not $parent.HasExited) {
    Write-UpdateLog "Parent process did not exit in time; aborting without touching the installation."
    exit 1
}

$newFiles = Get-ManifestFiles -SourceDirectory $staged
$backupApplication = Join-Path $backup 'application'
$oldLockHash = Get-FileHashOrEmpty -PathValue (Join-Path $target 'package-lock.json')
$newLookup = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($file in $newFiles) { [void]$newLookup.Add($file) }

function Restore-PreviousApplication {
    Write-UpdateLog 'Restoring the previous application files.'
    foreach ($file in $newFiles) {
        $destination = Get-AbsolutePath (Join-Path $target ($file.Replace('/', [System.IO.Path]::DirectorySeparatorChar)))
        Assert-ChildPath -Child $destination -Root $target -Description 'Rollback destination'
        Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath (Join-Path $target 'nodepilot-release.json') -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $backupApplication -PathType Container) {
        foreach ($entry in Get-ChildItem -LiteralPath $backupApplication -Force) {
            $restoreDestination = Join-Path $target $entry.Name
            Remove-Item -LiteralPath $restoreDestination -Recurse -Force -ErrorAction SilentlyContinue
            Copy-Item -LiteralPath $entry.FullName -Destination $restoreDestination -Recurse -Force
        }
    }
    try {
        Invoke-Npm -Arguments @('ci')
    } catch {
        Write-UpdateLog "Could not restore dependencies automatically: $($_.Exception.Message)"
    }
}

try {
    New-Item -ItemType Directory -Path $backupApplication -Force | Out-Null
    foreach ($entry in Get-ChildItem -LiteralPath $target -Force) {
        if (@('.nodepilot', '.git', 'node_modules', '.env') -contains $entry.Name.ToLowerInvariant()) { continue }
        Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $backupApplication $entry.Name) -Recurse -Force
    }

    $oldManifestFiles = @()
    if (Test-Path -LiteralPath (Join-Path $backupApplication 'nodepilot-release.json') -PathType Leaf) {
        $oldManifestFiles = Get-ManifestFiles -SourceDirectory $backupApplication
    }

    Write-UpdateLog 'Copying verified release files into the installation.'
    foreach ($file in $newFiles) {
        $source = Get-AbsolutePath (Join-Path $staged ($file.Replace('/', [System.IO.Path]::DirectorySeparatorChar)))
        $destination = Get-AbsolutePath (Join-Path $target ($file.Replace('/', [System.IO.Path]::DirectorySeparatorChar)))
        Assert-ChildPath -Child $source -Root $staged -Description 'Staged source'
        Assert-ChildPath -Child $destination -Root $target -Description 'Update destination'
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }
    Copy-Item -LiteralPath (Join-Path $staged 'nodepilot-release.json') -Destination (Join-Path $target 'nodepilot-release.json') -Force

    foreach ($file in $oldManifestFiles) {
        if ($newLookup.Contains($file)) { continue }
        $destination = Get-AbsolutePath (Join-Path $target ($file.Replace('/', [System.IO.Path]::DirectorySeparatorChar)))
        Assert-ChildPath -Child $destination -Root $target -Description 'Stale release file'
        Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
    }

    $newLockHash = Get-FileHashOrEmpty -PathValue (Join-Path $target 'package-lock.json')
    if ($oldLockHash -ne $newLockHash -or -not (Test-Path -LiteralPath (Join-Path $target 'node_modules') -PathType Container)) {
        Write-UpdateLog 'Installing dependencies required by the new release.'
        Push-Location $target
        try { Invoke-Npm -Arguments @('ci') } finally { Pop-Location }
    }

    Write-UpdateLog 'Building NodePilot before restart.'
    Push-Location $target
    try { Invoke-Npm -Arguments @('run', 'build') } finally { Pop-Location }
    if (
        -not (Test-Path -LiteralPath (Join-Path $target 'server\dist\index.js') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $target 'client\dist\index.html') -PathType Leaf)
    ) {
        throw 'The updated application did not produce both server and client build outputs.'
    }
} catch {
    Write-UpdateLog "Update failed: $($_.Exception.Message)"
    try { Restore-PreviousApplication } catch { Write-UpdateLog "Rollback failed: $($_.Exception.Message)" }
    exit 1
}

Write-UpdateLog 'Update applied successfully. Cleaning staged files and relaunching NodePilot.'
Remove-Item -LiteralPath $staged -Recurse -Force -ErrorAction SilentlyContinue
$launcher = Join-Path $target 'start.bat'
if (Test-Path -LiteralPath $launcher -PathType Leaf) {
    Start-Process -FilePath 'cmd.exe' -ArgumentList ('/d /c "' + $launcher + '"') -WorkingDirectory $target -WindowStyle Hidden
} else {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $npm) { $npm = Get-Command npm -ErrorAction Stop }
    Start-Process -FilePath $npm.Source -ArgumentList 'start' -WorkingDirectory $target -WindowStyle Hidden
}
Write-UpdateLog 'Relaunch requested.'
