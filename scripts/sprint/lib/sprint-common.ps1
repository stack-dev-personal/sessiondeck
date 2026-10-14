# Shared helpers for run-sprint.ps1, status.ps1 and stop-sprint.ps1. Dot-source this file.
# Runs on Windows PowerShell 5.1 and PowerShell 7, so: no ternary, no ??, no && or ||,
# ASCII only. Output goes through [Console] so that stdout and stderr stay separate and
# ordered when a caller redirects them.

# Exit codes shared by the three scripts. Documented in scripts/README.md.
$ExitOk = 0
$ExitBadInput = 2
$ExitPrerequisite = 3
$ExitStateConflict = 4
$ExitDockerFailure = 5

# The id becomes a directory under .sprint/ and a bind-mount source, so ".." or a path
# separator would mount the wrong directory. \z, not $, because $ also matches before a
# trailing newline. No hyphen: stop-sprint matches sibling containers by the prefix sd-<id>-,
# so ids "a" and "a-b" would claim each other's containers. infra/sprint/entrypoint.sh still
# accepts hyphens; that is looser than this rule and harmless, because these scripts start it.
$SprintIdPattern = '^[A-Za-z0-9][A-Za-z0-9_]*\z'
$SprintIdRule = 'letters, digits and underscore, starting with a letter or digit'
$ContractShaPattern = '^[A-Za-z0-9._/-]+\z'

$ContainerPrefix = 'sprint-'
# Sibling test containers a session starts are named sd-<sprint>-<session>-* (infra/sprint/README.md).
$SiblingContainerPrefix = 'sd-'
# The image compose runs. Set explicitly on every start so that an ambient SPRINT_IMAGE (or a
# stray infra/sprint/.env) cannot swap in another image that then receives both tokens.
$DefaultSprintImage = 'sessiondeck-sprint:local'
# Accepted without -AllowForeignImage: a locally built sessiondeck-sprint tag.
$SprintImagePattern = '^sessiondeck-sprint:[A-Za-z0-9._-]+\z'
# Shape check for anything else, once -AllowForeignImage was given.
$ImageReferencePattern = '^[A-Za-z0-9][A-Za-z0-9._/:@-]*\z'
# Docker contexts that point at the local Docker Desktop daemon.
$LocalDockerContexts = @('default', 'desktop-linux')
$StatusFileName = 'status.json'
$SessionsDirName = 'sessions'
$StateRootDirName = '.sprint'
$ComposeRelativePath = 'infra/sprint/docker-compose.yml'

function Write-Line {
    param([string]$Text)
    [Console]::Out.WriteLine($Text)
}

function Write-ErrorLine {
    param([string]$Text)
    [Console]::Error.WriteLine($Text)
}

# Prints the message on stderr and ends the calling script with the given code.
function Exit-Sprint {
    param([int]$Code, [string]$Message)
    if ($Message) {
        Write-ErrorLine $Message
    }
    exit $Code
}

function Test-SprintId {
    param([string]$Id)
    if ([string]::IsNullOrEmpty($Id)) {
        return $false
    }
    return [bool]($Id -cmatch $SprintIdPattern)
}

# Validates before any other work. Names the rule so the user can fix the input.
function Assert-SprintId {
    param([string]$Id, [string]$Tool)
    if (-not (Test-SprintId $Id)) {
        Exit-Sprint $ExitBadInput "${Tool}: invalid sprint id. An id may contain only ${SprintIdRule} (pattern ${SprintIdPattern})."
    }
}

function Get-ContainerName {
    param([string]$Id)
    return "${ContainerPrefix}${Id}"
}

# $true on Windows PowerShell 5.1 (Windows only) and on PowerShell 7 running on Windows.
function Test-IsWindowsHost {
    if ($PSVersionTable.PSVersion.Major -lt 6) {
        return $true
    }
    return [bool]$IsWindows
}

# Absolute path from what the user typed, relative to the PowerShell location (not the
# process directory, which differs after Set-Location).
function Resolve-FullPath {
    param([string]$Path)
    return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

# The form docker compose gets: absolute, forward slashes (works from PowerShell and Git Bash
# on Docker Desktop for Windows, and is a no-op on Linux).
function ConvertTo-DockerPath {
    param([string]$Path)
    $full = Resolve-FullPath $Path
    if (Test-IsWindowsHost) {
        return $full.Replace('\', '/')
    }
    return $full
}

# scripts/sprint is two levels below the repo root.
function Resolve-RepoRoot {
    param([string]$Given, [string]$ScriptDir)
    if ([string]::IsNullOrEmpty($Given)) {
        return [IO.Path]::GetFullPath([IO.Path]::Combine($ScriptDir, '..', '..'))
    }
    return Resolve-FullPath $Given
}

function Resolve-StateRoot {
    param([string]$Given, [string]$RepoRoot)
    if ([string]::IsNullOrEmpty($Given)) {
        return [IO.Path]::Combine($RepoRoot, $StateRootDirName)
    }
    return Resolve-FullPath $Given
}

function Test-CommandAvailable {
    param([string]$Name)
    return ($null -ne (Get-Command $Name -ErrorAction SilentlyContinue))
}

# Sets process environment variables for the duration of the body and restores them after,
# so compose variables reach docker through the environment and never through a command
# string. The body must return the native exit code itself.
function Invoke-WithEnvironment {
    param([hashtable]$Variables, [scriptblock]$Body)
    $saved = @{}
    foreach ($name in $Variables.Keys) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, [string]$Variables[$name], 'Process')
    }
    try {
        return (& $Body)
    }
    finally {
        foreach ($name in $saved.Keys) {
            [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
        }
    }
}
