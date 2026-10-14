<#
.SYNOPSIS
Prints every .sprint/*/status.json as one table and every .sprint/*/sessions/*.json as a
second one. Read-only; what the conductor runs on each poll.

.DESCRIPTION
Columns follow PROMPT-BOOK.md section 6. A file that is missing, empty, partly written or not
a JSON object shows as "unreadable" (or "no status.json") for that row and never stops the
table. Exit code is 0 in every case that reaches the table, including "nothing to show".

.PARAMETER Root
Directory holding one state directory per sprint. Default: <repo>/.sprint.
#>
[CmdletBinding()]
param(
    [string]$Root = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. ([IO.Path]::Combine($PSScriptRoot, 'lib', 'sprint-common.ps1'))

$UnreadableText = 'unreadable'
$MissingText = 'no status.json'
$UnknownText = '-'
$TableWidth = 400

function Read-JsonObject {
    param([string]$Path)
    try {
        $text = [IO.File]::ReadAllText($Path)
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
function Get-Field {
    param($Object, [string]$Name)
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop -or $null -eq $prop.Value) {
        return $UnknownText
    }
    return [string]$prop.Value
}

# updated_at as text plus whole minutes since then. PowerShell 7 turns ISO strings into
# DateTime while 5.1 keeps text, so accept both.
function Get-UpdatedAt {
    param($Object)
    $prop = $Object.PSObject.Properties['updated_at']
    if ($null -eq $prop -or $null -eq $prop.Value) {
        return @($UnknownText, $UnknownText)
    }
    $value = $prop.Value
    $stamp = [DateTimeOffset]::MinValue
    if ($value -is [DateTime]) {
        $stamp = [DateTimeOffset]$value.ToUniversalTime()
    }
    elseif (-not [DateTimeOffset]::TryParse([string]$value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$stamp)) {
        return @([string]$value, $UnknownText)
    }
    $minutes = [int][Math]::Floor(([DateTimeOffset]::UtcNow - $stamp).TotalMinutes)
    return @($stamp.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ'), [string]$minutes)
}

# "2 green, 1 blocked" from the sessions map of status.json.
function Get-SessionCounts {
    param($Status)
    $prop = $Status.PSObject.Properties['sessions']
    if ($null -eq $prop -or $prop.Value -isnot [System.Management.Automation.PSCustomObject]) {
        return $UnknownText
    }
    $counts = [ordered]@{}
    foreach ($entry in $prop.Value.PSObject.Properties) {
        $state = $UnknownText
        if ($entry.Value -is [System.Management.Automation.PSCustomObject]) {
            $state = Get-Field $entry.Value 'state'
        }
        if ($counts.Contains($state)) { $counts[$state] += 1 } else { $counts[$state] = 1 }
    }
    if ($counts.Count -eq 0) {
        return 'none yet'
    }
    return (($counts.Keys | ForEach-Object { "$($counts[$_]) $_" }) -join ', ')
}

function New-SprintRow {
    param([string]$Id, [string]$StatusPath)
    $row = [ordered]@{ sprint = $Id; state = $MissingText; sessions = $UnknownText; pr = $UnknownText; updated_at = $UnknownText; age_min = $UnknownText }
    if (-not (Test-Path -LiteralPath $StatusPath -PathType Leaf)) {
        return [pscustomobject]$row
    }
    $status = Read-JsonObject -Path $StatusPath
    if ($null -eq $status) {
        $row.state = $UnreadableText
        return [pscustomobject]$row
    }
    $when = Get-UpdatedAt $status
    $row.state = Get-Field $status 'state'
    $row.sessions = Get-SessionCounts $status
    $row.pr = Get-Field $status 'pr'
    $row.updated_at = $when[0]
    $row.age_min = $when[1]
    return [pscustomobject]$row
}

function New-SessionRow {
    param([string]$SprintId, [IO.FileInfo]$File)
    $row = [ordered]@{ sprint = $SprintId; session = [IO.Path]::GetFileNameWithoutExtension($File.Name); state = $UnreadableText; current_unit = $UnknownText; updated_at = $UnknownText; age_min = $UnknownText }
    $session = Read-JsonObject -Path $File.FullName
    if ($null -eq $session) {
        return [pscustomobject]$row
    }
    $when = Get-UpdatedAt $session
    $row.state = Get-Field $session 'state'
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
    Write-Line "No status files found under ${rootPath}."
}
if ($sprintRows.Count -gt 0) {
    Write-Line (Format-Rows $sprintRows)
}
if ($sessionRows.Count -gt 0) {
    Write-Line ''
    Write-Line (Format-Rows $sessionRows)
}
exit $ExitOk
