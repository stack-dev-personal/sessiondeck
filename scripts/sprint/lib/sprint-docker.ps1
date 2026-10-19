# Read-only docker queries shared by run-sprint.ps1 and stop-sprint.ps1. Dot-source after
# sprint-common.ps1. The docker binary is found on PATH like any other command; there is
# deliberately no switch for choosing it.

# Exact container names matching a sprint. docker's name filter is a substring match and
# its regex anchors (^ and $) would need escaping through cmd shims, so filter loosely here
# and compare exactly in PowerShell.
function Get-MatchingContainerNames {
    param([string]$Name, [switch]$IncludeStopped)
    $queryArgs = @('ps')
    if ($IncludeStopped) {
        $queryArgs += '-a'
    }
    $queryArgs += @('--filter', "name=${Name}", '--format', '{{.Names}}')
    $lines = & docker @queryArgs
    if ($LASTEXITCODE -ne 0) {
        Exit-Sprint $ExitDockerFailure "docker ps failed with exit code ${LASTEXITCODE}; is Docker running?"
    }
    $names = @()
    foreach ($line in @($lines)) {
        $text = ([string]$line).Trim()
        if ($text -ceq $Name) {
            $names += $text
        }
    }
    return , $names
}

function Test-ContainerRunning {
    param([string]$Name)
    return ((Get-MatchingContainerNames -Name $Name).Count -gt 0)
}

function Test-ContainerExists {
    param([string]$Name)
    return ((Get-MatchingContainerNames -Name $Name -IncludeStopped).Count -gt 0)
}

# Names that start exactly with Prefix, compared case-sensitively. docker's name filter is a
# regex substring match, so "sd-1-" would also list "sd-10-hub" and "x-sd-1-y"; the prefix
# check here is what decides which containers are ours.
function Get-SiblingContainerNames {
    param([string]$Prefix)
    $lines = & docker ps -a --filter "name=${Prefix}" --format '{{.Names}}'
    if ($LASTEXITCODE -ne 0) {
        Exit-Sprint $ExitDockerFailure "docker ps failed with exit code ${LASTEXITCODE}; is Docker running?"
    }
    $names = @()
    foreach ($line in @($lines)) {
        $text = ([string]$line).Trim()
        if ($text.StartsWith($Prefix, [StringComparison]::Ordinal)) {
            $names += $text
        }
    }
    return , $names
}

# Refuses to go on when DOCKER_HOST, DOCKER_CONTEXT or DOCKER_CONFIG would send the compose
# request, with the env_file values (both tokens), to a daemon other than the local one. Names
# the variable, never its value: the value may be an address or carry credentials. Environment
# only, no docker call; Assert-LocalDockerContext covers the context saved in the docker config.
function Assert-LocalDockerTarget {
    param([string]$Tool)
    $dockerHost = [Environment]::GetEnvironmentVariable('DOCKER_HOST', 'Process')
    if (-not [string]::IsNullOrEmpty($dockerHost)) {
        Exit-Sprint $ExitPrerequisite "${Tool}: DOCKER_HOST is set. Compose would send the token env file to that daemon; unset DOCKER_HOST and run again."
    }
    $dockerContext = [Environment]::GetEnvironmentVariable('DOCKER_CONTEXT', 'Process')
    if (-not [string]::IsNullOrEmpty($dockerContext) -and ($LocalDockerContexts -cnotcontains $dockerContext)) {
        Exit-Sprint $ExitPrerequisite "${Tool}: DOCKER_CONTEXT is set to something other than $($LocalDockerContexts -join ' or '). Compose would send the token env file to that daemon; unset DOCKER_CONTEXT and run again."
    }
    # A config directory elsewhere can name any current context, and reading it is out of scope
    # here; refuse instead of guessing.
    $dockerConfig = [Environment]::GetEnvironmentVariable('DOCKER_CONFIG', 'Process')
    if (-not [string]::IsNullOrEmpty($dockerConfig)) {
        Exit-Sprint $ExitPrerequisite "${Tool}: DOCKER_CONFIG is set. It can point docker at another context and daemon; unset DOCKER_CONFIG and run again."
    }
}

# The context chosen with "docker context use" is saved in the docker config, not in the
# environment. Compose would send the env_file values to that context's daemon, so only the local
# ones pass. Needs docker on PATH (the caller checks that first). Neither the context name nor
# docker's output is echoed.
function Assert-LocalDockerContext {
    param([string]$Tool)
    # Windows PowerShell 5.1 turns a stderr line of a native command into a terminating error
    # under Stop, even when redirected.
    $ErrorActionPreference = 'Continue'
    $all = @(& docker context show 2>&1)
    $contextExit = $LASTEXITCODE
    $lines = @($all | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] })
    $current = ([string]($lines -join ' ')).Trim()
    if ($contextExit -ne 0) {
        Exit-Sprint $ExitPrerequisite "${Tool}: docker context show failed (exit code ${contextExit}), so the daemon that would receive the token env file is unknown. Fix docker and run again."
    }
    if ($LocalDockerContexts -cnotcontains $current) {
        Exit-Sprint $ExitPrerequisite "${Tool}: the current docker context is not $($LocalDockerContexts -join ' or '). Compose would send the token env file to that daemon; run docker context use default and run again."
    }
}

# "<id> created <time>" of a local image, or '' when the image does not exist. This is the
# image compose will start unless it has to build one. Only docker's "No such image" answer
# means missing; any other failure (a stopped daemon, for one) ends the script with exit 5.
function Get-ImageSummary {
    param([string]$Image)
    # Windows PowerShell 5.1 turns any stderr line of a native command into a terminating error
    # under Stop, even when redirected. A missing image is an expected answer here, not an error.
    $ErrorActionPreference = 'Continue'
    $all = @(& docker image inspect --format '{{.Id}} created {{.Created}}' $Image 2>&1)
    $inspectExit = $LASTEXITCODE
    $out = @()
    $err = @()
    foreach ($item in $all) {
        if ($item -is [System.Management.Automation.ErrorRecord]) {
            $err += $item.ToString()
        }
        else {
            $out += [string]$item
        }
    }
    if ($inspectExit -eq 0) {
        return ($out -join ' ').Trim()
    }
    if ((($err + $out) -join "`n") -match 'No such image') {
        return ''
    }
    Exit-Sprint $ExitDockerFailure "docker image inspect failed with exit code ${inspectExit}; is Docker running?"
}
