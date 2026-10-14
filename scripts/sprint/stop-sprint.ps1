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

function Invoke-Docker {
    param([string[]]$DockerArgs)
    & docker @DockerArgs | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Exit-Sprint $ExitDockerFailure "${Tool}: docker $($DockerArgs -join ' ') failed with exit code ${LASTEXITCODE}."
    }
}

$mainExists = Test-ContainerExists -Name $containerName
# Test containers a session started (sd-<id>-<session>-*) would otherwise keep using RAM.
$siblingPrefix = "${SiblingContainerPrefix}${Sprint}-"
$siblings = Get-SiblingContainerNames -Prefix $siblingPrefix

if (-not $mainExists -and $siblings.Count -eq 0) {
    Write-Line "no container named ${containerName} and none named ${siblingPrefix}*; nothing to stop."
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
    Write-Line "kept: volume ${containerName}-work and the state directory"
    exit $ExitOk
}

if ($mainExists) {
    Invoke-Docker -DockerArgs @('stop', $containerName)
    Invoke-Docker -DockerArgs @('rm', $containerName)
}
if ($siblings.Count -gt 0) {
    Invoke-Docker -DockerArgs (@('stop') + $siblings)
    Invoke-Docker -DockerArgs (@('rm') + $siblings)
}

$networks = & docker network ls --filter "name=${networkName}" --format '{{.Name}}'
if ($LASTEXITCODE -eq 0 -and (@($networks) -contains $networkName)) {
    Invoke-Docker -DockerArgs @('network', 'rm', $networkName)
}

$removed = @()
if ($mainExists) { $removed += $containerName }
$removed += $siblings
Write-Line ("stopped and removed " + ($removed -join ' ') + "; kept volume ${containerName}-work and the state directory.")
exit $ExitOk
