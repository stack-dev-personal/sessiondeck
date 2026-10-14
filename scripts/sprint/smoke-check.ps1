<#
.SYNOPSIS
One command for the Sprint 0 smoke gate (R0.8): starts the smoke container, waits for
<state root>/smoke/status.json to turn green, prints one evidence block and stops the
container.

.DESCRIPTION
Specification: infra/sprint/README.md, "Smoke test". Runs run-sprint.ps1 -Sprint smoke, polls the
status file, prints PASS or FAIL with the start and wait times, the final state, the container exit code
and the tail of logs/entrypoint.log, then runs stop-sprint.ps1 -Sprint smoke.

Stale state: run-sprint refuses a sprint whose status.json exists (exit 4), and a stale green file
would be a false PASS. So this script deletes <state root>/smoke/status.json, that one file and
nothing else, before it starts. It never uses -Resume, and it never touches any other path.

Everything printed from the state directory is untrusted (the container writes it). The status
state is reduced to a schema word, log lines are cut and reduced to printable ASCII, and docker
logs and the env file are never printed. The entrypoint log can still hold secrets: do not paste
the evidence anywhere public without reading it.

Timing: the two minutes (-TimeoutSeconds) count from the moment run-sprint returns. The time
run-sprint took, which includes an image build of about 10 minutes when the image is missing, is
printed as start_seconds, and the evidence says when the image was missing.

Exit codes: 0 PASS; 1 FAIL (timeout, container exited, or state not green; also an unexpected
error inside run-sprint); otherwise the exit code of run-sprint.ps1 when that failed (2 bad
input, 3 prerequisite missing, 4 already running or state conflict, 5 docker failure).
stop-sprint runs after a successful start and after run-sprint exit 5 (a half-started container),
unless -KeepContainer; it is skipped after run-sprint exit 1, 2, 3 or 4 (exit 1 is the unexpected
error above; with 2, 3 and 4 no container of this run was started, and after 4 the running one is
not this run's, so stop-sprint would remove it). A failing stop does not change the exit
code but is shown in the evidence.

.PARAMETER EnvFile
Env file with the two tokens, passed to run-sprint.ps1. Default: <state root>/env.
.PARAMETER StateRoot
Directory holding one state directory per sprint. Default: <repo>/.sprint.
.PARAMETER RepoRoot
Repository root, passed to run-sprint.ps1. Default: two levels above this script.
.PARAMETER TimeoutSeconds
Longest wait for green. Default 120 (the R0.8 limit is two minutes).
.PARAMETER PollSeconds
Seconds between checks. Default 3.
.PARAMETER KeepContainer
Do not run stop-sprint.ps1 at the end (to inspect the container).
.PARAMETER EvidenceFile
Also write the evidence block to this file (ASCII, LF).
#>
[CmdletBinding()]
param(
    [string]$EnvFile = '',
    [string]$StateRoot = '',
    [string]$RepoRoot = '',
    [ValidateRange(1, 3600)][int]$TimeoutSeconds = 120,
    [ValidateRange(1, 60)][int]$PollSeconds = 3,
    [switch]$KeepContainer,
    [string]$EvidenceFile = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$libDir = [IO.Path]::Combine($PSScriptRoot, 'lib')
. ([IO.Path]::Combine($libDir, 'sprint-common.ps1'))
. ([IO.Path]::Combine($libDir, 'sprint-docker.ps1'))
. ([IO.Path]::Combine($libDir, 'sprint-sanitize.ps1'))
. ([IO.Path]::Combine($libDir, 'sprint-links.ps1'))

$Tool = 'smoke-check'
$SmokeId = 'smoke'
$ExitPass = 0
$ExitFail = 1
$GreenState = 'green'
$LogTailLines = 20
$LogLineWidth = 200
# Bytes read from the end of the log; a runaway log is never loaded whole.
$LogReadCapBytes = 65536
$PathWidth = 200
# Same cap and same state words as status.ps1.
$MaxStatusFileBytes = 262144
$SprintStates = @('running', 'blocked', 'merging', 'gate', 'awaiting-merge-approval', 'merged', 'failed', 'green')
$NoStatusText = 'no status.json'
$UnreadableText = 'unreadable'
$TooLargeText = 'too large'
$ContainerStatusPattern = '^([a-z]+) (-?\d+)$'
$EvidenceNote = 'NOTE: the entrypoint log and docker logs can hold secrets. Read them yourself; do not paste them into a chat or an issue.'

# --- Status file: size-capped read, schema word only ---

# 'missing', 'unreadable', 'too large' or the sanitized state word ('invalid' if not in the schema).
function Get-SmokeState {
    param([string]$Root, [string]$Path)
    if ((Find-LinkedComponent -Root $Root -Path $Path) -ne '') {
        return $LinkRefusedText
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $NoStatusText
    }
    try {
        $buffer = New-Object byte[] ($MaxStatusFileBytes + 1)
        $total = 0
        $stream = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            while ($total -lt $buffer.Length) {
                $read = $stream.Read($buffer, $total, $buffer.Length - $total)
                if ($read -le 0) {
                    break
                }
                $total += $read
            }
        }
        finally {
            $stream.Dispose()
        }
        if ($total -gt $MaxStatusFileBytes) {
            return $TooLargeText
        }
        $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $total).TrimStart([char]0xFEFF)
        $parsed = $text | ConvertFrom-Json
    }
    catch {
        # A file the container is still writing is half a document; the next poll reads it again.
        return $UnreadableText
    }
    if ($parsed -isnot [System.Management.Automation.PSCustomObject]) {
        return $UnreadableText
    }
    $prop = $parsed.PSObject.Properties['state']
    if ($null -eq $prop) {
        return $InvalidText
    }
    return (ConvertTo-EnumText $prop.Value $SprintStates)
}

# --- Container: status word and exit code, never logs ---

# @{ Known = $false } when the container does not exist; otherwise Known, Status, ExitCode.
function Get-ContainerFacts {
    param([string]$Name)
    # Windows PowerShell 5.1 turns a stderr line of a native command into a terminating error
    # under Stop; a missing container is an expected answer here.
    $ErrorActionPreference = 'Continue'
    $all = @(& docker container inspect --format '{{.State.Status}} {{.State.ExitCode}}' $Name 2>&1)
    if ($LASTEXITCODE -ne 0) {
        return @{ Known = $false; Status = ''; ExitCode = '' }
    }
    $lines = @($all | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] })
    $line = ([string]($lines -join ' ')).Trim()
    if ($line -cmatch $ContainerStatusPattern) {
        return @{ Known = $true; Status = $Matches[1]; ExitCode = $Matches[2] }
    }
    return @{ Known = $false; Status = ''; ExitCode = '' }
}

function Format-ContainerFacts {
    param($Facts)
    if (-not $Facts.Known) {
        return 'not found'
    }
    if ($Facts.Status -ceq 'exited') {
        return "exited, exit code $($Facts.ExitCode)"
    }
    return (ConvertTo-SafeText $Facts.Status)
}

# --- Entrypoint log tail, sanitized ---

function Get-LogTail {
    param([string]$Root, [string]$Path)
    $linked = Find-LinkedComponent -Root $Root -Path $Path
    if ($linked -ne '') {
        return @("(entrypoint.log not read: '$(ConvertTo-SafeText $linked 120)' is a link, refused)")
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return @('(no entrypoint.log on the host side)')
    }
    try {
        $stream = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            $start = [Math]::Max(0, $stream.Length - $LogReadCapBytes)
            [void]$stream.Seek($start, [IO.SeekOrigin]::Begin)
            $buffer = New-Object byte[] ([int]($stream.Length - $start))
            $total = 0
            while ($total -lt $buffer.Length) {
                $read = $stream.Read($buffer, $total, $buffer.Length - $total)
                if ($read -le 0) {
                    break
                }
                $total += $read
            }
        }
        finally {
            $stream.Dispose()
        }
    }
    catch {
        return @('(entrypoint.log could not be read)')
    }
    $lines = @([Text.Encoding]::UTF8.GetString($buffer, 0, $total) -split "`r?`n")
    if ($start -gt 0 -and $lines.Count -gt 0) {
        # The first line begins before the window.
        $lines = @($lines | Select-Object -Skip 1)
    }
    while ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') {
        $lines = @($lines | Select-Object -First ($lines.Count - 1))
    }
    if ($lines.Count -eq 0) {
        return @('(entrypoint.log is empty)')
    }
    $tail = @($lines | Select-Object -Last $LogTailLines)
    return @($tail | ForEach-Object { ConvertTo-SafeText $_ $LogLineWidth })
}

# --- Start ---

$repo = Resolve-RepoRoot -Given $RepoRoot -ScriptDir $PSScriptRoot
$stateRootPath = Resolve-StateRoot -Given $StateRoot -RepoRoot $repo
$smokeDir = [IO.Path]::Combine($stateRootPath, $SmokeId)
$statusPath = [IO.Path]::Combine($smokeDir, $StatusFileName)
$logPath = [IO.Path]::Combine($smokeDir, 'logs', 'entrypoint.log')
$containerName = Get-ContainerName -Id $SmokeId

$runScript = [IO.Path]::Combine($PSScriptRoot, 'run-sprint.ps1')
$stopScript = [IO.Path]::Combine($PSScriptRoot, 'stop-sprint.ps1')

if (-not (Test-CommandAvailable 'docker')) {
    Exit-Sprint $ExitPrerequisite "${Tool}: docker is not on PATH."
}

# A local daemon only, before anything else (also before the image query below).
Assert-LocalDockerTarget -Tool $Tool
Assert-LocalDockerContext -Tool $Tool

# The container owns the state directory and can plant links in it. Remove-Item on a path below a
# link would delete in the link's target, so refuse first.
Assert-NoLinkBelow -Root $stateRootPath -Path $statusPath -Tool $Tool
Assert-NoLinkBelow -Root $stateRootPath -Path $logPath -Tool $Tool

# Only this one file is ever removed (see .DESCRIPTION).
if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
    Remove-Item -LiteralPath $statusPath -Force
    Write-Line "removed the previous ${statusPath} so the new run starts clean."
}

$runArgs = @{ Sprint = $SmokeId; StateRoot = $stateRootPath }
if ($EnvFile -ne '') {
    $runArgs['EnvFile'] = $EnvFile
}
if ($RepoRoot -ne '') {
    $runArgs['RepoRoot'] = $RepoRoot
}

# A missing image makes compose build it, about 10 minutes. That time belongs to the start, not to
# the wait for green, so ask first and report it in the evidence.
$imageMissing = ((Get-ImageSummary -Image $DefaultSprintImage) -eq '')

$startClock = [Diagnostics.Stopwatch]::StartNew()
$runExit = 0
try {
    & $runScript @runArgs
    $runExit = $LASTEXITCODE
}
catch {
    Write-ErrorLine "${Tool}: run-sprint failed unexpectedly: $(ConvertTo-SafeText $_.Exception.Message 300)"
    $runExit = $ExitFail
}
$startClock.Stop()

# --- Wait for green, exit of the container, or the timeout ---

# The wait clock starts only now, after run-sprint (and any image build) returned.
$clock = [Diagnostics.Stopwatch]::StartNew()

$finalState = $NoStatusText
$facts = @{ Known = $false; Status = ''; ExitCode = '' }
$green = $false
if ($runExit -eq $ExitOk) {
    while ($true) {
        $finalState = Get-SmokeState -Root $stateRootPath -Path $statusPath
        if ($finalState -ceq $GreenState) {
            $green = $true
            break
        }
        $facts = Get-ContainerFacts -Name $containerName
        if (-not $facts.Known -or $facts.Status -cne 'running') {
            # The container is gone or finished; it may have written the file just before.
            $finalState = Get-SmokeState -Root $stateRootPath -Path $statusPath
            $green = ($finalState -ceq $GreenState)
            break
        }
        if ($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
            break
        }
        Start-Sleep -Seconds $PollSeconds
    }
    $facts = Get-ContainerFacts -Name $containerName
}
$clock.Stop()

# --- Stop ---

$stopText = 'skipped (-KeepContainer)'
if ($KeepContainer) {
    $stopText = 'skipped (-KeepContainer)'
}
elseif ($runExit -ne $ExitOk -and $runExit -ne $ExitDockerFailure) {
    $stopText = 'skipped (run-sprint did not start a container)'
}
else {
    $stopExit = $ExitFail
    try {
        & $stopScript -Sprint $SmokeId | Out-Null
        $stopExit = $LASTEXITCODE
    }
    catch {
        $stopExit = $ExitFail
    }
    $stopText = "ran, exit ${stopExit}"
    if ($stopExit -ne $ExitOk) {
        $stopText += " (check docker ps -a for ${containerName})"
    }
}

# --- Evidence ---

$result = 'FAIL'
$exitCode = $ExitFail
if ($runExit -ne $ExitOk -and $runExit -ne $ExitFail) {
    $exitCode = $runExit
}
elseif ($green) {
    $result = 'PASS'
    $exitCode = $ExitPass
}

$invariant = [Globalization.CultureInfo]::InvariantCulture
$startSeconds = $startClock.Elapsed.TotalSeconds.ToString('0.0', $invariant)
$waitSeconds = $clock.Elapsed.TotalSeconds.ToString('0.0', $invariant)
$imageText = 'present (reused, no build)'
if ($imageMissing -and $runExit -eq $ExitOk) {
    $imageText = "missing before the start: compose built it (about 10 minutes, counted in start_seconds, not in the wait)"
}
elseif ($imageMissing) {
    $imageText = 'missing; run-sprint did not start, nothing was built'
}
$block = @(
    '=== smoke check evidence ===',
    "RESULT: ${result}",
    "start_seconds: ${startSeconds} (run-sprint, including any image build)",
    "wait_seconds: ${waitSeconds} (limit ${TimeoutSeconds}, counted after run-sprint returned)",
    "image ${DefaultSprintImage}: ${imageText}",
    "final_state: ${finalState}",
    "container: $(Format-ContainerFacts $facts)",
    "run-sprint exit: ${runExit}",
    "stop-sprint: ${stopText}",
    "--- last ${LogTailLines} lines of $(ConvertTo-SafeText $logPath $PathWidth) (printable ASCII only) ---"
)
$block += Get-LogTail -Root $stateRootPath -Path $logPath
$block += '---'
$block += $EvidenceNote
$block += '=== end evidence ==='
$blockText = $block -join "`n"

Write-Line $blockText

if ($EvidenceFile -ne '') {
    try {
        $evidencePath = Resolve-FullPath $EvidenceFile
        $evidenceDir = [IO.Path]::GetDirectoryName($evidencePath)
        [void][IO.Directory]::CreateDirectory($evidenceDir)
        [IO.File]::WriteAllText($evidencePath, $blockText + "`n", (New-Object Text.ASCIIEncoding))
        Write-Line "evidence saved to $(ConvertTo-SafeText $evidencePath $PathWidth)"
    }
    catch {
        Write-ErrorLine "${Tool}: could not write the evidence file."
    }
}

exit $exitCode
