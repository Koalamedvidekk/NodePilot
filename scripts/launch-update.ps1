# Launch the verified updater in an independent hidden Windows console. A Node
# DETACHED_PROCESS has no console, which can prevent Windows PowerShell startup.
param(
    [Parameter(Mandatory = $true)][string]$ScriptFile,
    [Parameter(Mandatory = $true)][string]$ArgumentsBase64,
    [Parameter(Mandatory = $true)][string]$ReadyFile
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Quote-Literal([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }

$script = [System.IO.Path]::GetFullPath($ScriptFile)
$ready = [System.IO.Path]::GetFullPath($ReadyFile)
$childReady = $ready + '.child'
$values = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64)) | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw 'The verified updater script is missing.' }
if ($values -isnot [System.Array] -or $values.Count -lt 2 -or $values.Count % 2 -ne 0 -or @($values | Where-Object { $_ -isnot [string] }).Count -gt 0) { throw 'Updater arguments are invalid.' }
$readyIndex = [Array]::IndexOf($values, '-ReadyFile')
if ($readyIndex -lt 0 -or $readyIndex + 1 -ge $values.Count) { throw 'The updater readiness argument is invalid.' }
$providedChildReady = [System.IO.Path]::GetFullPath([string]$values[$readyIndex + 1])
if (-not $providedChildReady.Equals($childReady, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'The updater readiness argument is invalid.' }
$values[$readyIndex + 1] = $providedChildReady

# Only literal arguments enter the encoded script. A path containing apostrophes,
# spaces, dollar signs or shell punctuation remains a single literal value.
$parameters = @{}
$assignments = @()
for ($index = 0; $index -lt $values.Count; $index += 2) {
    $name = $values[$index]
    if ($name -notmatch '^-[A-Za-z][A-Za-z0-9]*$' -or $parameters.ContainsKey($name)) { throw 'Updater parameter names are invalid.' }
    $parameters[$name] = $true
    $assignments += (Quote-Literal $name.Substring(1)) + ' = ' + (Quote-Literal $values[$index + 1])
}
$invocation = '$parameters = @{ ' + ($assignments -join '; ') + ' }; & ' + (Quote-Literal $script) + ' @parameters'
$encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($invocation))
$stdout = $ready + '.stdout.log'
$stderr = $ready + '.stderr.log'
$child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded) -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
$confirmed = $false
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while ([DateTime]::UtcNow -lt $deadline) {
    $child.Refresh()
    if ($child.HasExited) {
        $details = if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Raw } else { '' }
        throw "The updater exited before readiness (exit $($child.ExitCode)). $details"
    }
    if (Test-Path -LiteralPath $childReady -PathType Leaf) {
        try {
            $status = Get-Content -LiteralPath $childReady -Raw | ConvertFrom-Json
            if ($status.ready -eq $true -and $status.pid -eq $child.Id) {
                [System.IO.File]::WriteAllText($ready, (@{ ready = $true; pid = $PID; helperPid = $child.Id } | ConvertTo-Json -Compress))
                $confirmed = $true
                break
            }
        } catch { }
    }
    Start-Sleep -Milliseconds 50
}
if (-not $confirmed) { throw 'The updater did not confirm readiness. The panel must remain running.' }
# The real helper owns an independent console and survives this bootstrap and
# NodePilot exiting. Keeping the bootstrap alive also preserves normal exit/error
# monitoring during the Node side of the readiness handshake.
$child.WaitForExit()
exit $child.ExitCode
