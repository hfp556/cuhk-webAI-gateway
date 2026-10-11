param(
    [switch]$InitializeOnly,
    [switch]$New
)

$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runtime.ps1')
Initialize-CuhkConfig $bridgeRoot
$configPath = Join-Path $bridgeRoot 'config.json'
$codexHome = Join-Path $bridgeRoot 'gateway\runtime-state\codex-home'
$gatewayCommand = Join-Path $PSScriptRoot 'cuhk-gateway.cmd'
$codexCommand = Join-Path $PSScriptRoot 'cuhk-codex.cmd'

function Initialize-CuhkCodexHome {
    $null = New-Item -ItemType Directory -Force -Path $codexHome
    $markerPath = Join-Path $codexHome '.cuhk-gateway-home'
    if (-not (Test-Path -LiteralPath $markerPath)) {
        [IO.File]::WriteAllText(
            $markerPath,
            "This CODEX_HOME is reserved for CUHK Gateway CLI sessions.`r`n",
            [Text.UTF8Encoding]::new($false)
        )
    }
}

function Test-CuhkCodexHistory([string]$Directory) {
    # The native resume picker filters sessions by their recorded working
    # directory, so an empty picker means this folder has no history yet.
    $sessions = Join-Path $codexHome 'sessions'
    if (-not (Test-Path -LiteralPath $sessions -PathType Container)) { return $false }
    $wanted = $Directory.TrimEnd('\')
    $files = Get-ChildItem -LiteralPath $sessions -Recurse -File -Filter '*.jsonl' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 200
    foreach ($file in $files) {
        try {
            $reader = [IO.File]::OpenText($file.FullName)
            try { $head = $reader.ReadLine() } finally { $reader.Close() }
        } catch { continue }
        if ($head -and $head -match '"cwd":"((?:[^"\\]|\\.)*)"') {
            $recorded = ($Matches[1] -replace '\\\\', '\').TrimEnd('\')
            if ($recorded -ieq $wanted) { return $true }
        }
    }
    return $false
}

function Enable-CuhkGateway {
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    if (-not $config.gatewayEnabled) {
        if ($config.PSObject.Properties.Name -contains 'gatewayEnabled') {
            $config.gatewayEnabled = $true
        } else {
            $config | Add-Member -NotePropertyName gatewayEnabled -NotePropertyValue $true
        }
        $temporaryPath = "$configPath.tmp"
        $json = $config | ConvertTo-Json -Depth 10
        [IO.File]::WriteAllText($temporaryPath, "$json`r`n", [Text.UTF8Encoding]::new($false))
        Move-Item -Force -LiteralPath $temporaryPath -Destination $configPath
    }
}

try {
    $host.UI.RawUI.WindowTitle = 'CUHK Gateway Codex CLI'
    Write-Host 'Initializing the isolated Gateway CLI data directory...' -ForegroundColor Cyan
    Initialize-CuhkCodexHome
    Enable-CuhkGateway

    if ($InitializeOnly) {
        Write-Host "Initialization complete: $codexHome" -ForegroundColor Green
        exit 0
    }

    Write-Host 'Starting CUHK Gateway...' -ForegroundColor Cyan
    # No pipeline here: the gateway daemons inherit this console's stdout, and a
    # pipeline to a cmdlet would wait for an end-of-stream that never arrives.
    & $gatewayCommand start
    if ($LASTEXITCODE -ne 0) { throw "CUHK Gateway failed to start (exit code $LASTEXITCODE)." }

    $currentDirectory = [string](Get-Location)
    if ($New) {
        Write-Host 'Starting a new conversation in this folder...' -ForegroundColor Cyan
        & $codexCommand
    } elseif (Test-CuhkCodexHistory $currentDirectory) {
        Write-Host 'Opening this folder''s Gateway CLI sessions...' -ForegroundColor Cyan
        & $codexCommand resume
    } else {
        # Without history the native picker shows an empty list and the window
        # looks broken, so start the first conversation in this folder instead.
        Write-Host 'This folder has no saved conversation yet, starting a new one.' -ForegroundColor Yellow
        & $codexCommand
    }
    exit $LASTEXITCODE
} catch {
    Write-Host "Launch failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Press Enter to close this window.'
    [void](Read-Host)
    exit 1
}
