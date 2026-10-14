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
