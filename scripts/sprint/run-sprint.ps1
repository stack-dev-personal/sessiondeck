<#
.SYNOPSIS
Renders the level-1 prompt for one sprint, creates .sprint/<id>/, and starts the sprint
container detached as sprint-<id>.

.DESCRIPTION
Specification: infra/sprint/README.md. Tokens reach the container only through the env file
(compose env_file). This script checks that the file exists and warns about its permissions;
it never reads, prints, hashes or copies its content.

Exit codes: 0 started (or dry run ok), 2 bad input, 3 prerequisite missing (or DOCKER_HOST /
DOCKER_CONTEXT point away from the local daemon), 4 already running or state conflict,
5 docker failure.

.PARAMETER Sprint
Sprint id: a package id from MINI-SPRINT-ORDER.md, or "smoke".
.PARAMETER Resume
Start a new container against the existing .sprint/<id>/ and keep everything in it.
.PARAMETER ContractSha
Contract commit on main; required for every sprint except 0 and smoke.
.PARAMETER DryRun
Do everything except the docker call that changes state; print that call instead.
.PARAMETER EnvFile
Env file with the two tokens. Default: <repo>/.sprint/env.
.PARAMETER RepoRoot
Repository root. Default: two levels above this script.
.PARAMETER StateRoot
Directory that holds one state directory per sprint. Default: <repo>/.sprint.
.PARAMETER RepoUrl
https://github.com/OWNER/REPO clone URL for the container. Default: the origin remote of the
repository. Any other value must name the same owner and repository as origin (compared
case-insensitively against the origin URL text) unless -AllowForeignRepo is given.
.PARAMETER AllowForeignRepo
Accept a -RepoUrl that differs from origin. The container runs that repository's CLAUDE.md,
hooks and agents with both tokens, so use this only for a repository you trust as much as
this one.
.PARAMETER Image
Image compose starts, and therefore the image that receives both tokens. Default:
sessiondeck-sprint:local. Without -AllowForeignImage only sessiondeck-sprint:<tag> is accepted.
.PARAMETER AllowForeignImage
Accept an -Image that is not sessiondeck-sprint:<tag>. Use it only for an image you built
yourself; the container gets both tokens.
.PARAMETER Build
Pass --build to compose up, so a changed Dockerfile or entrypoint is picked up. Without it
compose builds only when the image is missing.
#>
[CmdletBinding()]
param(
    [string]$Sprint = '',
    [switch]$Resume,
    [string]$ContractSha = '',
    [switch]$DryRun,
    [string]$EnvFile = '',
    [string]$RepoRoot = '',
    [string]$StateRoot = '',
    [string]$RepoUrl = '',
    [switch]$AllowForeignRepo,
    [string]$Image = '',
    [switch]$AllowForeignImage,
    [switch]$Build
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$libDir = [IO.Path]::Combine($PSScriptRoot, 'lib')
. ([IO.Path]::Combine($libDir, 'sprint-common.ps1'))
. ([IO.Path]::Combine($libDir, 'sprint-docker.ps1'))
. ([IO.Path]::Combine($libDir, 'sprint-envfile.ps1'))
. ([IO.Path]::Combine($libDir, 'sprint-repourl.ps1'))

$Tool = 'run-sprint'
# Same directories as STATE_SUBDIRS in packages/contract/src/state-file-paths.ts. Only the
# directories are made here; the orchestrator writes status.json.
$StateSubdirs = @('sessions', 'prompts', 'questions', 'answers', 'logs', 'reports', 'screens', 'gate')
$PromptFileName = 'sprint-prompt.md'
$RendererRelativePath = 'render-prompt.mjs'
# Renderer exit 2 is a usage error (unknown sprint id, missing --contract-sha).
$RendererUsageExit = 2
# Only containers run this way; "local" packages (sprint 0) are run by sessions on the laptop.
$ContainerRunsIn = 'container'
# The compose file's directory; compose reads a .env file there for interpolation even with -f.
$ComposeDirEnvFileName = '.env'

# --- 1. Input validation, before anything else ---

Assert-SprintId -Id $Sprint -Tool $Tool
if ($Image -eq '') {
    $Image = $DefaultSprintImage
}
if (-not ($Image -cmatch $SprintImagePattern)) {
    # The image receives both tokens, so a registry path or someone else's local image needs a
    # deliberate switch. The value is not echoed.
    if (-not $AllowForeignImage) {
        Exit-Sprint $ExitBadInput "${Tool}: -Image must be sessiondeck-sprint:<tag> (pattern ${SprintImagePattern}). The image receives both tokens; pass -AllowForeignImage only for an image you built yourself."
    }
    if (-not ($Image -cmatch $ImageReferencePattern)) {
        Exit-Sprint $ExitBadInput "${Tool}: -Image must look like a docker image reference (pattern ${ImageReferencePattern})."
    }
}
# Compose sends the env_file values to whichever daemon these variables name.
Assert-LocalDockerTarget -Tool $Tool
if ($ContractSha -ne '' -and -not ($ContractSha -cmatch $ContractShaPattern)) {
    Exit-Sprint $ExitBadInput "${Tool}: -ContractSha may contain only letters, digits and . _ / -"
}

$repo = Resolve-RepoRoot -Given $RepoRoot -ScriptDir $PSScriptRoot
$stateRootPath = Resolve-StateRoot -Given $StateRoot -RepoRoot $repo
$stateDir = [IO.Path]::Combine($stateRootPath, $Sprint)
$statusFile = [IO.Path]::Combine($stateDir, $StatusFileName)
$promptFile = [IO.Path]::Combine($stateDir, $PromptFileName)
$composeFile = [IO.Path]::Combine($repo, $ComposeRelativePath.Replace('/', [string][IO.Path]::DirectorySeparatorChar))
$renderer = [IO.Path]::Combine($PSScriptRoot, $RendererRelativePath)
$containerName = Get-ContainerName -Id $Sprint

if ($EnvFile -eq '') {
    $envFilePath = [IO.Path]::Combine($stateRootPath, 'env')
}
else {
    $envFilePath = Resolve-FullPath $EnvFile
}

# --- 2. Prerequisites: name everything that is missing ---

$missing = @()
if (-not (Test-CommandAvailable 'node')) { $missing += 'node (not on PATH)' }
if (-not (Test-CommandAvailable 'docker')) { $missing += 'docker (not on PATH)' }
if (-not (Test-Path -LiteralPath $envFilePath -PathType Leaf)) {
    $missing += "env file ${envFilePath} (create it once with CLAUDE_CODE_OAUTH_TOKEN and GH_TOKEN; see infra/sprint/README.md)"
}
if (-not (Test-Path -LiteralPath $composeFile -PathType Leaf)) { $missing += "compose file ${composeFile}" }
if (-not (Test-Path -LiteralPath $renderer -PathType Leaf)) { $missing += "renderer ${renderer}" }
if ($missing.Count -gt 0) {
    Exit-Sprint $ExitPrerequisite ("${Tool}: missing prerequisites:`n  - " + ($missing -join "`n  - "))
}

# compose reads <compose dir>/.env for variable interpolation even when -f is given; the file
# is gitignored, so it would not show in git status, and it could switch the image.
$composeEnvFile = [IO.Path]::Combine([IO.Path]::GetDirectoryName($composeFile), $ComposeDirEnvFileName)
if (Test-Path -LiteralPath $composeEnvFile) {
    Exit-Sprint $ExitPrerequisite "${Tool}: ${composeEnvFile} exists. Compose would read it for variable interpolation (it can switch the image that receives the tokens). Delete or rename it, then run again."
}

Write-EnvFileWarning -Path $envFilePath

# The URL is never echoed when rejected: it may carry credentials.
$repoUrlRule = 'https://github.com/OWNER/REPO or https://github.com/OWNER/REPO.git, without credentials, port, query or spaces'
$usedOrigin = ($RepoUrl -eq '')
if ($usedOrigin) {
    $RepoUrl = Get-OriginUrl -Repo $repo
    if ($RepoUrl -eq '') {
        Exit-Sprint $ExitPrerequisite "${Tool}: cannot read the origin remote of ${repo} (is git installed?); pass -RepoUrl <clone url>."
    }
}
$repoKey = Get-GitHubRepoKey -Url $RepoUrl
if ($null -eq $repoKey) {
    Exit-Sprint $ExitBadInput "${Tool}: the repository URL must be ${repoUrlRule}."
}
if (-not $usedOrigin -and -not $AllowForeignRepo) {
    $originUrl = Get-OriginUrl -Repo $repo
    if ($originUrl -eq '') {
        Exit-Sprint $ExitPrerequisite "${Tool}: cannot read the origin remote of ${repo} to compare with -RepoUrl; fix the remote or pass -AllowForeignRepo."
    }
    $originKey = Get-GitHubRepoKey -Url $originUrl -AllowSsh
    if ($null -eq $originKey) {
        Exit-Sprint $ExitBadInput "${Tool}: the origin remote is not a github.com URL, so -RepoUrl cannot be checked against it; pass -AllowForeignRepo to accept it."
    }
    if ($repoKey -cne $originKey) {
        Exit-Sprint $ExitBadInput "${Tool}: -RepoUrl names a different repository than origin. The container would run that repository's CLAUDE.md, hooks and agents with both tokens; pass -AllowForeignRepo only if you trust it."
    }
}

# --- 3. Package facts from the renderer (also validates the sprint id) ---

# A renderer failure ends the script with the renderer's own message (it prints to stderr).
function Stop-OnRendererFailure {
    param([int]$RendererExit)
    if ($RendererExit -eq 0) {
        return
    }
    $mapped = $ExitPrerequisite
    if ($RendererExit -eq $RendererUsageExit) {
        $mapped = $ExitBadInput
    }
    Exit-Sprint $mapped "${Tool}: the prompt renderer failed (exit ${RendererExit}); see its message above."
}

$rendererArgs = @($renderer, '--sprint', $Sprint, '--repo-root', (ConvertTo-DockerPath $repo))
if ($ContractSha -ne '') {
    $rendererArgs += @('--contract-sha', $ContractSha)
}

$packageText = & node @rendererArgs '--package-json'
Stop-OnRendererFailure -RendererExit $LASTEXITCODE
# Render once to nowhere so that input problems (a missing -ContractSha, a damaged
# PROMPT-BOOK.md) surface before any docker query or file is written.
& node @rendererArgs | Out-Null
Stop-OnRendererFailure -RendererExit $LASTEXITCODE
$package = (@($packageText) -join "`n") | ConvertFrom-Json
$branch = ''
if ($null -ne $package.branch) {
    $branch = [string]$package.branch
}
# A package whose sessions run on the laptop (sprint 0) must not be started in a container: an
# unwatched orchestrator would redo the same work on the same p0/* branches as the local sessions.
$runsIn = ''
if ($null -ne $package.PSObject.Properties['runs_in']) {
    $runsIn = [string]$package.runs_in
}
if ($runsIn -cne $ContainerRunsIn) {
    $runsInMessage = "${Tool}: sprint ${Sprint} has runs_in='${runsIn}', not '${ContainerRunsIn}'; its sessions are run locally (see CONDUCTOR.md), not in a container."
    if (-not $DryRun) {
        Exit-Sprint $ExitBadInput $runsInMessage
    }
    Write-ErrorLine "warning: ${runsInMessage} Without -DryRun this would exit 2."
}

# --- 4. State conflicts and running containers, before writing anything ---

if ($Resume) {
    if (-not (Test-Path -LiteralPath $stateDir -PathType Container)) {
        Exit-Sprint $ExitStateConflict "${Tool}: -Resume needs the existing state directory ${stateDir}; start without -Resume first."
    }
}
elseif (Test-Path -LiteralPath $statusFile -PathType Leaf) {
    Exit-Sprint $ExitStateConflict "${Tool}: ${statusFile} already exists, so sprint ${Sprint} has run before. Pass -Resume to continue it."
}

# -Resume is the documented restart for a stalled sprint whose container is still alive, and
# it passes --force-recreate, so only a plain start refuses.
if (-not $Resume -and (Test-ContainerRunning -Name $containerName)) {
    Exit-Sprint $ExitStateConflict "${Tool}: container ${containerName} is already running. Stop it with scripts/sprint/stop-sprint.ps1 -Sprint ${Sprint}."
}

# --- 5. State layout and prompt (local files only; a dry run writes them too) ---

foreach ($sub in $StateSubdirs) {
    New-Item -ItemType Directory -Force -Path ([IO.Path]::Combine($stateDir, $sub)) | Out-Null
}
& node @rendererArgs '--out' (ConvertTo-DockerPath $promptFile)
Stop-OnRendererFailure -RendererExit $LASTEXITCODE

# --- 6. Start the container ---

$composeVariables = [ordered]@{
    SPRINT_IMAGE      = $Image
    SPRINT_ID         = $Sprint
    SPRINT_BRANCH     = $branch
    SPRINT_REPO_URL   = $RepoUrl
    SPRINT_ENV_FILE   = (ConvertTo-DockerPath $envFilePath)
    SPRINT_STATE_ROOT = (ConvertTo-DockerPath $stateRootPath)
}
$composeArgs = @('compose', '-p', $containerName, '-f', (ConvertTo-DockerPath $composeFile), 'up', '-d')
if ($Resume) {
    # A resumed sprint must not reuse the stopped container's old environment.
    $composeArgs += '--force-recreate'
}
if ($Build) {
    $composeArgs += '--build'
}

# Which image will run: compose builds only when the tag is missing, so say what exists.
$imageSummary = Get-ImageSummary -Image $Image
if ($Build) {
    Write-Line "image ${Image}: -Build given, compose rebuilds it first; this can take about 10 minutes."
}
elseif ($imageSummary -eq '') {
    Write-Line "image ${Image}: image missing: compose will build it, this can take about 10 minutes."
}
else {
    Write-Line "image ${Image}: ${imageSummary} (compose reuses it; pass -Build after changing infra/sprint)"
}

if ($DryRun) {
    Write-Line "dry run: nothing was started. State directory and prompt were written to ${stateDir}"
    Write-Line ('would run: docker ' + ($composeArgs -join ' '))
    Write-Line 'with these compose variables (no tokens are passed on the command line or through the environment):'
    foreach ($name in $composeVariables.Keys) {
        Write-Line ("  ${name}=" + $composeVariables[$name])
    }
    exit $ExitOk
}

$variables = @{}
foreach ($name in $composeVariables.Keys) {
    $variables[$name] = $composeVariables[$name]
}
$upExit = Invoke-WithEnvironment -Variables $variables -Body {
    # Out-Host keeps docker's progress text out of the value this block returns.
    & docker @composeArgs | Out-Host
    return $LASTEXITCODE
}
if ($upExit -ne 0) {
    Exit-Sprint $ExitDockerFailure "${Tool}: docker compose up failed with exit code ${upExit}; see its output above."
}

Write-Line "started ${containerName}; state in ${stateDir}"
Write-Line 'watch it with scripts/sprint/status.ps1; stop it with scripts/sprint/stop-sprint.ps1'
exit $ExitOk
