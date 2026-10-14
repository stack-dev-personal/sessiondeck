<#
.SYNOPSIS
Prints every .sprint/*/status.json as one table and every .sprint/*/sessions/*.json as a
second one. Read-only; what the conductor runs on each poll.

.DESCRIPTION
Columns follow PROMPT-BOOK.md section 6. A file that is missing, empty, partly written or not
a JSON object shows as "unreadable" (or "no status.json") for that row and never stops the
table. Exit code is 0 in every case that reaches the table, including "nothing to show".

The files are written by the sprint container and are untrusted. Every value is cut to a fixed
width and reduced to printable ASCII before it is printed, state values outside the schema
show as "invalid", and a file over the size cap shows as "too large" and is not parsed.

.PARAMETER Root
Directory holding one state directory per sprint. Default: <repo>/.sprint.
#>
[CmdletBinding()]
param(
    [string]$Root = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$libDir = [IO.Path]::Combine($PSScriptRoot, 'lib')
. ([IO.Path]::Combine($libDir, 'sprint-common.ps1'))
. ([IO.Path]::Combine($libDir, 'sprint-sanitize.ps1'))

$UnreadableText = 'unreadable'
$MissingText = 'no status.json'
$TooLargeText = 'too large'
$UnknownText = '-'
$TableWidth = 400
# A real status file is a few KiB; anything near this size is not one.
$MaxStatusFileBytes = 262144

# PROMPT-BOOK.md section 6, plus green (the smoke package's terminal state) as accepted by
# packages/contract/src/state-file-schemas.ts.
$SprintStates = @('running', 'blocked', 'merging', 'gate', 'awaiting-merge-approval', 'merged', 'failed', 'green')
$SessionStates = @('not-started', 'running', 'blocked', 'green', 'failed')
$GateStates = @('pending', 'pass', 'fail')

# A PSCustomObject, $null (unreadable) or $TooLargeText. Reads at most the cap plus one byte,
# so a huge file is never loaded.
function Read-JsonObject {
    param([string]$Path)
    try {
        $buffer = New-Object byte[] ($MaxStatusFileBytes + 1)
        $total = 0
        $stream = [IO.File]::OpenRead($Path)
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
        return $null
    }
    if ($parsed -is [System.Management.Automation.PSCustomObject]) {
        return $parsed
    }
    return $null
}

# Strict mode makes a missing property an error; schema fields are all optional here.
function Get-RawField {
    param($Object, [string]$Name)
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) {
        return $null
    }
    # The leading comma stops PowerShell from unrolling an array value on the way out, which
    # would turn a one-element array into a bare scalar.
    return , $prop.Value
}

# Free text field, cleaned and cut.
function Get-Field {
    param($Object, [string]$Name)
    $value = Get-RawField $Object $Name
    if ($null -eq $value) {
        return $UnknownText
    }
    return (ConvertTo-SafeText $value)
}

# A field that must be one of the schema words.
function Get-EnumField {
    param($Object, [string]$Name, [string[]]$Allowed)
    $value = Get-RawField $Object $Name
    if ($null -eq $value) {
        return $UnknownText
    }
    return (ConvertTo-EnumText $value $Allowed)
}

# updated_at as text plus whole minutes since then. PowerShell 7 turns ISO strings into
# DateTime while 5.1 keeps text, so accept both.
function Get-UpdatedAt {
    param($Object)
    $value = Get-RawField $Object 'updated_at'
    if ($null -eq $value) {
        return @($UnknownText, $UnknownText)
    }
    $stamp = [DateTimeOffset]::MinValue
    if ($value -is [DateTime]) {
        $stamp = [DateTimeOffset]$value.ToUniversalTime()
    }
    elseif (-not [DateTimeOffset]::TryParse([string]$value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$stamp)) {
        return @((ConvertTo-SafeText $value), $UnknownText)
    }
    # long: a year-0001 stamp is billions of minutes, which does not fit an int.
    $minutes = [long][Math]::Floor(([DateTimeOffset]::UtcNow - $stamp).TotalMinutes)
    return @($stamp.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ'), [string]$minutes)
}

# "2 green, 1 blocked" from the sessions map of status.json.
function Get-SessionCounts {
    param($Status)
    $sessions = Get-RawField $Status 'sessions'
    if ($sessions -isnot [System.Management.Automation.PSCustomObject]) {
        return $UnknownText
    }
    $counts = [ordered]@{}
    foreach ($entry in $sessions.PSObject.Properties) {
        $state = $UnknownText
        if ($entry.Value -is [System.Management.Automation.PSCustomObject]) {
            $state = Get-EnumField $entry.Value 'state' $SessionStates
        }
        if ($counts.Contains($state)) { $counts[$state] += 1 } else { $counts[$state] = 1 }
    }
    if ($counts.Count -eq 0) {
        return 'none yet'
    }
    return (($counts.Keys | ForEach-Object { "$($counts[$_]) $_" }) -join ', ')
}

# Number of entries of an array field (questions, needs_laptop_confirmation).
function Get-CountField {
    param($Object, [string]$Name)
    $value = Get-RawField $Object $Name
    if ($null -eq $value) {
        return '0'
    }
    if ($value -is [array]) {
        return [string]@($value).Count
    }
    return $InvalidText
}

# What needs the user, from PROMPT-BOOK.md section 6: questions, gate.state and
# needs_laptop_confirmation.
function Get-Waiting {
    param($Status)
    $gate = $UnknownText
    $gateValue = Get-RawField $Status 'gate'
    if ($null -ne $gateValue) {
        if ($gateValue -is [System.Management.Automation.PSCustomObject]) {
            $gate = Get-EnumField $gateValue 'state' $GateStates
        }
        else {
            $gate = $InvalidText
        }
    }
    $questions = Get-CountField $Status 'questions'
    $laptop = Get-CountField $Status 'needs_laptop_confirmation'
    return "questions=${questions} gate=${gate} needs_laptop_confirmation=${laptop}"
}

function New-SprintRow {
    param([string]$Id, [string]$StatusPath)
    $row = [ordered]@{ sprint = (ConvertTo-SafeText $Id); state = $MissingText; sessions = $UnknownText; waiting = $UnknownText; pr = $UnknownText; updated_at = $UnknownText; age_min = $UnknownText }
    if (-not (Test-Path -LiteralPath $StatusPath -PathType Leaf)) {
        return [pscustomobject]$row
    }
    $status = Read-JsonObject -Path $StatusPath
    if ($null -eq $status) {
        $row.state = $UnreadableText
        return [pscustomobject]$row
    }
    if ($status -is [string]) {
        $row.state = $status
        return [pscustomobject]$row
    }
    $when = Get-UpdatedAt $status
    $row.state = Get-EnumField $status 'state' $SprintStates
    $row.sessions = Get-SessionCounts $status
    $row.waiting = Get-Waiting $status
    $row.pr = Get-Field $status 'pr'
    $row.updated_at = $when[0]
    $row.age_min = $when[1]
    return [pscustomobject]$row
}

function New-SessionRow {
    param([string]$SprintId, [IO.FileInfo]$File)
    $name = [IO.Path]::GetFileNameWithoutExtension($File.Name)
    $row = [ordered]@{ sprint = (ConvertTo-SafeText $SprintId); session = (ConvertTo-SafeText $name); state = $UnreadableText; current_unit = $UnknownText; updated_at = $UnknownText; age_min = $UnknownText }
    $session = Read-JsonObject -Path $File.FullName
    if ($null -eq $session) {
        return [pscustomobject]$row
    }
    if ($session -is [string]) {
        $row.state = $session
        return [pscustomobject]$row
    }
    $when = Get-UpdatedAt $session
    $row.state = Get-EnumField $session 'state' $SessionStates
    $row.current_unit = Get-Field $session 'current_unit'
    $row.updated_at = $when[0]
    $row.age_min = $when[1]
    return [pscustomobject]$row
}

function Format-Rows {
    param($Rows)
    return ((@($Rows) | Format-Table -AutoSize | Out-String -Width $TableWidth).Trim())
}

if ($Root -eq '') {
    $repo = Resolve-RepoRoot -Given '' -ScriptDir $PSScriptRoot
    $rootPath = Resolve-StateRoot -Given '' -RepoRoot $repo
}
else {
    $rootPath = Resolve-FullPath $Root
}

$sprintDirs = @()
if (Test-Path -LiteralPath $rootPath -PathType Container) {
    $sprintDirs = @(Get-ChildItem -LiteralPath $rootPath -Directory | Sort-Object Name)
}

$sprintRows = @()
$sessionRows = @()
$statusCount = 0
foreach ($dir in $sprintDirs) {
    $statusPath = [IO.Path]::Combine($dir.FullName, $StatusFileName)
    if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
        $statusCount += 1
    }
    $sprintRows += New-SprintRow -Id $dir.Name -StatusPath $statusPath
    $sessionsDir = [IO.Path]::Combine($dir.FullName, $SessionsDirName)
    if (Test-Path -LiteralPath $sessionsDir -PathType Container) {
        foreach ($file in @(Get-ChildItem -LiteralPath $sessionsDir -File -Filter '*.json' | Sort-Object Name)) {
            $sessionRows += New-SessionRow -SprintId $dir.Name -File $file
        }
    }
}

if ($statusCount -eq 0) {
    Write-Line "No status files found under $(ConvertTo-SafeText $rootPath 200)."
}
if ($sprintRows.Count -gt 0) {
    Write-Line (Format-Rows $sprintRows)
}
if ($sessionRows.Count -gt 0) {
    Write-Line ''
    Write-Line (Format-Rows $sessionRows)
}
exit $ExitOk
