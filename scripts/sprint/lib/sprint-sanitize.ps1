# Text cleaning for status.ps1. Dot-source it. Everything status.ps1 prints comes from files
# the sprint container can write, so a session that was prompt-injected can put terminal
# escape sequences there (OSC 52 clipboard writes, cursor movement that overwrites rows).
# Only printable ASCII ever reaches the terminal.

# Longest text any single table cell can show.
$SafeFieldWidth = 40
$TruncationMarker = '...'
$ReplacementChar = '?'
$FirstPrintableCode = 0x20
$LastPrintableCode = 0x7E
$InvalidText = 'invalid'

# Truncates first (so a huge value is never walked char by char), then replaces every
# character outside 0x20-0x7E. That covers C0 controls, DEL, C1 controls (U+0080-U+009F, which
# include the single-byte CSI U+009B) and all non-ASCII text.
function ConvertTo-SafeText {
    param($Value, [int]$MaxLength = $SafeFieldWidth)
    if ($null -eq $Value) {
        return ''
    }
    $text = [string]$Value
    if ($text.Length -gt $MaxLength) {
        $keep = $MaxLength - $TruncationMarker.Length
        $text = $text.Substring(0, $keep) + $TruncationMarker
    }
    $builder = New-Object System.Text.StringBuilder
    foreach ($ch in $text.ToCharArray()) {
        $code = [int]$ch
        if ($code -ge $FirstPrintableCode -and $code -le $LastPrintableCode) {
            [void]$builder.Append($ch)
        }
        else {
            [void]$builder.Append($ReplacementChar)
        }
    }
    return $builder.ToString()
}

# A value that must be one of a fixed set of words: anything else (wrong type, wrong case,
# free text) shows as "invalid" instead of being echoed.
function ConvertTo-EnumText {
    param($Value, [string[]]$Allowed)
    if ($Value -is [string] -and ($Allowed -ccontains $Value)) {
        return $Value
    }
    return $InvalidText
}
