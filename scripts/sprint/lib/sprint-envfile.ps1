# Permission check for the sprint env file. Dot-source after sprint-common.ps1.
# It inspects permissions only. It never opens the file, so token values cannot reach
# any output, hash or copy made by these scripts.

# Principals that may read the env file without a warning.
$EnvFileAllowedPrincipals = @('NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')
# FileSystemRights.ReadData; any allow rule carrying this bit grants reading the file.
$FileSystemReadDataBit = 1
# POSIX group and other permission bits (0o077).
$UnixGroupOtherBits = 63

# Returns the names of principals, beyond the current user, SYSTEM and Administrators, that
# can read the file. NTFS ignores mode 600, so on Windows this reads the ACL. On other
# systems it reports group/other mode bits. An empty array means nothing to warn about.
function Get-EnvFileExtraReaders {
    param([string]$Path)
    if (Test-IsWindowsHost) {
        $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $allowed = @($me) + $EnvFileAllowedPrincipals
        $extra = @()
        foreach ($rule in (Get-Acl -LiteralPath $Path).Access) {
            if ($rule.AccessControlType -ne 'Allow') {
                continue
            }
            if (([int]$rule.FileSystemRights -band $FileSystemReadDataBit) -eq 0) {
                continue
            }
            $who = $rule.IdentityReference.Value
            if (($allowed -notcontains $who) -and ($extra -notcontains $who)) {
                $extra += $who
            }
        }
        return , $extra
    }
    $mode = [int][IO.File]::GetUnixFileMode($Path)
    if (($mode -band $UnixGroupOtherBits) -ne 0) {
        return , @('group or other mode bits set (chmod 600 the file)')
    }
    return , @()
}

# Warns, never fails: a permission we cannot read is not a reason to stop a sprint.
function Write-EnvFileWarning {
    param([string]$Path)
    try {
        $extra = Get-EnvFileExtraReaders -Path $Path
    }
    catch {
        Write-ErrorLine "warning: could not inspect the permissions of the env file (the file content was not read)."
        return
    }
    if ($extra.Count -gt 0) {
        $list = $extra -join ', '
        Write-ErrorLine "warning: the env file can be read by more than you, SYSTEM and Administrators: ${list}. Restrict it to your own account."
    }
}
