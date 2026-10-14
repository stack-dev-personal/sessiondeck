# Clone URL rules for run-sprint.ps1. Dot-source after sprint-common.ps1.
#
# Why this strict: the container clones the URL and then runs that repository's CLAUDE.md,
# hooks and agents headless with both tokens in its environment. A foreign repository would
# therefore run with the user's tokens, so the default is "this repository only".

$GitHubHttpsPattern = '^https://github\.com/(?<owner>[A-Za-z0-9._-]+)/(?<repo>[A-Za-z0-9._-]+?)(\.git)?\z'
# Only used to read the origin remote for the comparison, never as a clone URL.
$GitHubSshPattern = '^git@github\.com:(?<owner>[A-Za-z0-9._-]+)/(?<repo>[A-Za-z0-9._-]+?)(\.git)?\z'
$DotsOnlyPattern = '^\.+\z'

# "owner/repo" in lower case, or $null when the text is not a plain GitHub URL. Host, owner
# and repo names are case-insensitive on GitHub, so the key is lower case. Whitespace, ports,
# credentials, queries and fragments all fail the pattern.
function Get-GitHubRepoKey {
    param([string]$Url, [switch]$AllowSsh)
    $patterns = @($GitHubHttpsPattern)
    if ($AllowSsh) {
        $patterns += $GitHubSshPattern
    }
    foreach ($pattern in $patterns) {
        $m = [regex]::Match($Url, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if (-not $m.Success) {
            continue
        }
        $owner = $m.Groups['owner'].Value
        $repo = $m.Groups['repo'].Value
        if ($owner -match $DotsOnlyPattern -or $repo -match $DotsOnlyPattern) {
            return $null
        }
        return ("${owner}/${repo}").ToLowerInvariant()
    }
    return $null
}

# The origin remote as text, or '' when git or the remote is missing. Redirects are not
# resolved: the comparison is against exactly what `git remote get-url origin` prints.
function Get-OriginUrl {
    param([string]$Repo)
    if (-not (Test-CommandAvailable 'git')) {
        return ''
    }
    # See Get-ImageSummary: native stderr must not abort Windows PowerShell 5.1 under Stop.
    $ErrorActionPreference = 'Continue'
    $text = & git -C $Repo remote get-url origin 2>$null
    if ($LASTEXITCODE -ne 0) {
        return ''
    }
    return ([string](@($text) -join '')).Trim()
}
