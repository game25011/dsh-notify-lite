param(
    [long]$Hwnd = 0,
    [int]$Count = 0,
    [switch]$WarmOnly
)

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'taskbar-badge-helper.cs'
if (-not (Test-Path $source)) { throw "taskbar badge helper source missing: $source" }
$sha = [Security.Cryptography.SHA256]::Create()
try {
    $hashBytes = $sha.ComputeHash([IO.File]::ReadAllBytes($source))
} finally {
    $sha.Dispose()
}
$hash = -join ($hashBytes | ForEach-Object { $_.ToString('x2') })
$cacheRoot = Join-Path $env:LOCALAPPDATA 'dsh-notify-toast\native-cache'
$dll = Join-Path $cacheRoot ($hash + '.badge.dll')

function New-BadgeDll {
    New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path $csc)) { throw "csc not found: $csc" }
    $framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
    $refs = @(
        (Join-Path $framework 'System.dll'),
        (Join-Path $framework 'System.Drawing.dll'),
        (Join-Path $framework 'System.Runtime.dll')
    )
    foreach ($ref in $refs) { if (-not (Test-Path $ref)) { throw "reference missing: $ref" } }
    $temp = $dll + '.tmp-' + [guid]::NewGuid().ToString('N')
    $cscArgs = @('/nologo', '/target:library', ('/out:' + $temp))
    foreach ($ref in $refs) { $cscArgs += ('/r:' + $ref) }
    $cscArgs += $source
    $cscOutput = & $csc @cscArgs 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $temp)) {
        Remove-Item -Force -ErrorAction SilentlyContinue $temp
        throw ('taskbar badge helper compilation failed: ' + $cscOutput)
    }
    Move-Item -Force -Path $temp -Destination $dll
    return $dll
}

if (-not (Test-Path $dll)) { $dll = New-BadgeDll }
try {
    Add-Type -Path $dll
} catch {
    Remove-Item -Force -ErrorAction SilentlyContinue $dll
    $dll = New-BadgeDll
    Add-Type -Path $dll
}

if ($WarmOnly) {
    Write-Output 'warm'
    exit 0
}

[DshTaskbarBadge]::Set([IntPtr]$Hwnd, [int]$Count)
Write-Output ('badge:' + $Count)
