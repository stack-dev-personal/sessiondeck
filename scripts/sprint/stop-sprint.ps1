<#
.SYNOPSIS
Stops and removes the container sprint-<id> and any sibling test containers sd-<id>-*. Keeps
the work volume (resume needs it) and .sprint/<id>/.

.DESCRIPTION
Uses docker stop and docker rm rather than compose down: compose would need the env file and
the clone URL just to load the file, and neither is relevant to stopping. Neither command is
given a volume flag, so the named volume sprint-<id>-work survives.

Exit codes: 0 stopped, or no such container; 2 bad input; 3 docker missing; 5 docker failure.

.PARAMETER Sprint
Sprint id, as given to run-sprint.ps1.
.PARAMETER DryRun
Print the docker commands instead of running the ones that change state.
#>
[CmdletBinding()]
param(
    [string]$Sprint = '',
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$libDir = [IO.Path]::Combine($PSScriptRoot, 'lib')
. ([IO.Path]::Combine($libDir, 'sprint-common.ps1'))
. ([IO.Path]::Combine($libDir, 'sprint-docker.ps1'))

$Tool = 'stop-sprint'

Assert-SprintId -Id $Sprint -Tool $Tool

if (-not (Test-CommandAvailable 'docker')) {
    Exit-Sprint $ExitPrerequisite "${Tool}: docker is not on PATH."
}

$containerName = Get-ContainerName -Id $Sprint
# Compose names its default network <project>_default; docker rm leaves it behind.
$networkName = "${containerName}_default"

# A container started with --rm is removed by the daemon while docker stop or docker rm runs, so
# the answer to a name that vanished in between is not a failure. Docker words these two cases;
# every other error line stays a failure.
$GonePattern = '(?i)no such container|removal of container .+ is already in progress'

function Invoke-Docker {
    param([string[]]$DockerArgs, [switch]$TolerateGone)
    # Windows PowerShell 5.1 turns a stderr line of a native command into a terminating error
    # under Stop, even when redirected; the lines are inspected below instead.
    $ErrorActionPreference = 'Continue'
    $all = @(& docker @DockerArgs 2>&1)
    $dockerExit = $LASTEXITCODE
    $errorLines = @()
    foreach ($item in $all) {
        if ($item -is [System.Management.Automation.ErrorRecord]) {
            $errorLines += $item.ToString()
        }
        else {
            Write-Line ([string]$item)
        }
    }
    if ($dockerExit -eq 0) {
        return
    }
    $realErrors = @($errorLines | Where-Object { $_.Trim() -ne '' -and $_ -notmatch $GonePattern })
    if ($TolerateGone -and $errorLines.Count -gt 0 -and $realErrors.Count -eq 0) {
        return
    }
    foreach ($line in $errorLines) {
        Write-ErrorLine $line
    }
    Exit-Sprint $ExitDockerFailure "${Tool}: docker $($DockerArgs -join ' ') failed with exit code ${dockerExit}."
}

# Compose names its default network <project>_default; docker rm leaves it behind. Runs on every
# path that stops anything, and when nothing was left to stop: a retry after a half-finished stop
# must still clean up.
function Remove-ComposeNetwork {
    param([switch]$Preview)
    $networks = & docker network ls --filter "name=${networkName}" --format '{{.Name}}'
    if ($LASTEXITCODE -ne 0 -or (@($networks) -cnotcontains $networkName)) {
        return $false
    }
    if ($Preview) {
        Write-Line "  docker network rm ${networkName}"
        return $true
    }
    Invoke-Docker -DockerArgs @('network', 'rm', $networkName)
    return $true
}

$mainExists = Test-ContainerExists -Name $containerName
# Test containers a session started (sd-<id>-<session>-*) would otherwise keep using RAM.
$siblingPrefix = "${SiblingContainerPrefix}${Sprint}-"
$siblings = Get-SiblingContainerNames -Prefix $siblingPrefix

if (-not $mainExists -and $siblings.Count -eq 0) {
    Write-Line "no container named ${containerName} and none named ${siblingPrefix}*; nothing to stop."
    if ($DryRun) {
        [void](Remove-ComposeNetwork -Preview)
    }
    elseif (Remove-ComposeNetwork) {
        Write-Line "removed leftover network ${networkName}."
    }
    exit $ExitOk
}

if ($DryRun) {
    Write-Line "dry run: nothing was stopped. Would run:"
    if ($mainExists) {
        Write-Line "  docker stop ${containerName}"
        Write-Line "  docker rm ${containerName}"
    }
    if ($siblings.Count -gt 0) {
        Write-Line ("  docker stop " + ($siblings -join ' '))
        Write-Line ("  docker rm " + ($siblings -join ' '))
    }
    [void](Remove-ComposeNetwork -Preview)
    Write-Line "kept: volume ${containerName}-work and the state directory"
    exit $ExitOk
}

if ($mainExists) {
    Invoke-Docker -DockerArgs @('stop', $containerName) -TolerateGone
}
if ($siblings.Count -gt 0) {
    Invoke-Docker -DockerArgs (@('stop') + $siblings) -TolerateGone
}

# A container started with --rm is gone as soon as it stops, and docker rm on a missing name
# fails. Ask again and remove only what is still there.
$mainLeft = $mainExists -and (Test-ContainerExists -Name $containerName)
$siblingsLeft = @()
if ($siblings.Count -gt 0) {
    $stillThere = Get-SiblingContainerNames -Prefix $siblingPrefix
    $siblingsLeft = @($siblings | Where-Object { $stillThere -ccontains $_ })
}
if ($mainLeft) {
    Invoke-Docker -DockerArgs @('rm', $containerName) -TolerateGone
}
if ($siblingsLeft.Count -gt 0) {
    Invoke-Docker -DockerArgs (@('rm') + $siblingsLeft) -TolerateGone
}

[void](Remove-ComposeNetwork)

$stopped = @()
if ($mainExists) { $stopped += $containerName }
$stopped += $siblings
Write-Line ("stopped " + ($stopped -join ' ') + "; kept volume ${containerName}-work and the state directory.")
exit $ExitOk
