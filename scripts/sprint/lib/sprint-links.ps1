# Link refusal for the laptop-side sprint scripts. Dot-source after sprint-common.ps1 and
# sprint-sanitize.ps1. The sprint container owns .sprint/<id>/ and can create symbolic links
# there that Windows follows (a bind mount makes them real reparse points). A script that opens
# a path below the state root through such a link reads or writes any file the user can reach.
# So every path below the state root is checked, component by component from the root down,
# before it is opened, created or removed. The link target is never read or printed; only the
# sanitized path relative to the state root is named.
#
# Not covered: a link swapped in between the check and the open (the check is not atomic).
# The state root itself may be a link the user made on purpose; only components below it count.
# On Windows, OneDrive placeholder files also carry the reparse flag and are refused too.

$LinkRefusedText = 'link refused'
$LinkRelativeWidth = 120

# FileAttributes of the path itself (a link is not followed), or $null when it does not exist.
function Get-PathAttributes {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -ne $item) {
        return $item.Attributes
    }
    # A dangling link may not be returned by Get-Item on every PowerShell version.
    try {
        return [IO.File]::GetAttributes($Path)
    }
    catch {
        return $null
    }
}

function Test-ReparseAttributes {
    param($Attributes)
    if ($null -eq $Attributes) {
        return $false
    }
    return (([int]$Attributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0)
}

# '' when no component of Path below Root is a link; otherwise the relative path (forward
# slashes) up to and including the first link. A component that does not exist ends the walk:
# nothing below it can be followed.
function Find-LinkedComponent {
    param([string]$Root, [string]$Path)
    $separators = [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd($separators)
    $full = [IO.Path]::GetFullPath($Path)
    $comparison = [StringComparison]::Ordinal
    if (Test-IsWindowsHost) {
        $comparison = [StringComparison]::OrdinalIgnoreCase
    }
    if ($full.TrimEnd($separators).Length -le $rootFull.Length) {
        return ''
    }
    $prefix = $rootFull + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($prefix, $comparison)) {
        throw "Find-LinkedComponent: path is not below the state root."
    }
    $parts = $full.Substring($prefix.Length).Split($separators, [StringSplitOptions]::RemoveEmptyEntries)
    $current = $rootFull
    $walked = @()
    foreach ($part in $parts) {
        $current = [IO.Path]::Combine($current, $part)
        $walked += $part
        $attributes = Get-PathAttributes -Path $current
        if ($null -eq $attributes) {
            return ''
        }
        if (Test-ReparseAttributes $attributes) {
            return ($walked -join '/')
        }
    }
    return ''
}

# '' or the name of the first entry directly inside Dir that is a link. Used before a tool writes
# a file next to the others: a planted .tmp link beside the target would be followed by a writer
# that guesses the temporary name.
function Find-LinkedEntry {
    param([string]$Dir)
    try {
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($Dir)) {
            $attributes = $null
            try {
                $attributes = [IO.File]::GetAttributes($entry)
            }
            catch {
                continue
            }
            if (Test-ReparseAttributes $attributes) {
                return [IO.Path]::GetFileName($entry)
            }
        }
    }
    catch {
        return ''
    }
    return ''
}

function Get-LinkRefusedMessage {
    param([string]$Tool, [string]$Relative)
    $safe = ConvertTo-SafeText $Relative $LinkRelativeWidth
    return "${Tool}: refused: '${safe}' under the state directory is a link (symbolic link or junction). The sprint container can create links; this script does not follow them. Remove the link yourself (delete the link, not its target), then run again."
}

# Ends the calling script (exit 4, state conflict) when any component of Path below Root is a link.
function Assert-NoLinkBelow {
    param([string]$Root, [string]$Path, [string]$Tool)
    $linked = Find-LinkedComponent -Root $Root -Path $Path
    if ($linked -ne '') {
        Exit-Sprint $ExitStateConflict (Get-LinkRefusedMessage -Tool $Tool -Relative $linked)
    }
}
