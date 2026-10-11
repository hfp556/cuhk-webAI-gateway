function Get-CuhkNode {
    if ($env:CUHK_NODE_EXE) {
        if (-not (Test-Path -LiteralPath $env:CUHK_NODE_EXE -PathType Leaf)) {
            throw 'CUHK_NODE_EXE does not point to an existing Node executable.'
        }
        return $env:CUHK_NODE_EXE
    }
    $local = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime\node.exe'
    if (Test-Path -LiteralPath $local -PathType Leaf) { return $local }
    $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    # A per-user Node.js install (no administrator rights) is invisible in a shell
    # that was already running when PATH changed, so look in its standard place.
    $perUser = Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'
    if (Test-Path -LiteralPath $perUser -PathType Leaf) { return $perUser }
    $bundled = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $bundled) { return $bundled }
    throw 'Node.js 22 or newer was not found. Install Node.js with npm and add it to PATH, or set CUHK_NODE_EXE.'
}

function Initialize-CuhkConfig([string]$Root) {
    $target = Join-Path $Root 'config.json'
    if (-not (Test-Path -LiteralPath $target)) {
        # Copy without replacing a configuration created by another launcher.
        try { [IO.File]::Copy((Join-Path $Root 'config.example.json'), $target, $false) }
        catch { if (-not (Test-Path -LiteralPath $target)) { throw } }
    }
}
