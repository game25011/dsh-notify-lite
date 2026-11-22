param(
    [switch]$FromStdin,
    [switch]$WarmOnly
)

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'native-toast-helper.cs'
if (-not (Test-Path $source)) { throw "helper source missing: $source" }
$hash = (Get-FileHash -Algorithm SHA256 -Path $source).Hash.ToLowerInvariant()
$cacheRoot = Join-Path $env:LOCALAPPDATA 'dsh-notify-lite\native-cache'
$dll = Join-Path $cacheRoot ($hash + '.dll')

function New-HelperDll {
    New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path $csc)) { throw "csc not found: $csc" }
    $winmdRoot = Join-Path $env:WINDIR 'System32\WinMetadata'
    $refs = @(
        (Join-Path $winmdRoot 'Windows.Foundation.winmd'),
        (Join-Path $winmdRoot 'Windows.UI.winmd'),
        (Join-Path $winmdRoot 'Windows.Data.winmd'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.Runtime.WindowsRuntime.dll'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.Runtime.InteropServices.WindowsRuntime.dll'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.Runtime.dll')
    )
    foreach ($ref in $refs) { if (-not (Test-Path $ref)) { throw "reference missing: $ref" } }
    $temp = $dll + '.tmp-' + [guid]::NewGuid().ToString('N')
    $cscArgs = @('/nologo', '/target:library', ('/out:' + $temp))
    foreach ($ref in $refs) { $cscArgs += ('/r:' + $ref) }
    $cscArgs += $source
    $cscOutput = & $csc @cscArgs 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $temp)) {
        Remove-Item -Force -ErrorAction SilentlyContinue $temp
        throw ('native-toast helper compilation failed: ' + $cscOutput)
    }
    Move-Item -Force -Path $temp -Destination $dll
    return $dll
}

if (-not (Test-Path $dll)) { $dll = New-HelperDll }
try {
    Add-Type -Path $dll
} catch {
    # A torn or stale cache must not block a real notification. Rebuild once.
    Remove-Item -Force -ErrorAction SilentlyContinue $dll
    $dll = New-HelperDll
    Add-Type -Path $dll
}

if ($WarmOnly) {
    Write-Output 'warm'
    exit 0
}

$payloadBase64 = if ($FromStdin) { [Console]::In.ReadToEnd().Trim() } else { '' }
if ([string]::IsNullOrWhiteSpace($payloadBase64)) { throw 'native-toast payload is missing' }
$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payloadBase64))
$payload = $payloadJson | ConvertFrom-Json

[DshNativeToast]::Run(
    [string]$payload.aumid,
    [string]$payload.tag,
    [string]$payload.group,
    [string]$payload.title,
    [string]$payload.body,
    [string]$payload.progressLabel,
    [string]$payload.sessionId,
    [string]$payload.notificationId,
    [string]$payload.callbackUrl,
    [string]$payload.token,
    [int]$payload.durationMs
)
