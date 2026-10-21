param(
    [Parameter(Mandatory = $true)] [string] $Port,
    [Parameter(Mandatory = $true)] [string] $Image,
    [Parameter(Mandatory = $true)] [string] $ExpectedSha256,
    [string] $Python = "python"
)

$ErrorActionPreference = "Stop"
$resolved = (Resolve-Path -LiteralPath $Image).Path
$file = Get-Item -LiteralPath $resolved
if ($file.Length -le 0 -or $file.Length -gt 0x500000) {
    throw "App image must be non-empty and no larger than the verified 5 MiB app0 partition."
}

$actual = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash
if ($actual -ne $ExpectedSha256.ToUpperInvariant()) {
    throw "SHA-256 mismatch. Expected $ExpectedSha256, got $actual."
}

Write-Host "Image:   $resolved"
Write-Host "Size:    $($file.Length) bytes"
Write-Host "SHA-256: $actual"
Write-Host "Target:  $Port app0 only at 0x10000"

$versionText = (& $Python -m esptool version 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '(?i)esptool(?:\.py)?\s+v?(\d+)\.') {
    throw "Could not determine esptool major version: $versionText"
}
$esptoolMajor = [int] $Matches[1]
$beforeReset = if ($esptoolMajor -ge 5) { "default-reset" } else { "default_reset" }
$afterReset = if ($esptoolMajor -ge 5) { "hard-reset" } else { "hard_reset" }
$writeFlash = if ($esptoolMajor -ge 5) { "write-flash" } else { "write_flash" }
$flashMode = if ($esptoolMajor -ge 5) { "--flash-mode" } else { "--flash_mode" }
$flashFreq = if ($esptoolMajor -ge 5) { "--flash-freq" } else { "--flash_freq" }
$flashSize = if ($esptoolMajor -ge 5) { "--flash-size" } else { "--flash_size" }
Write-Host "esptool: v$esptoolMajor reset syntax selected"

& $Python -m esptool --chip esp32s3 --port $Port `
    --before $beforeReset --after $afterReset --no-stub `
    $writeFlash $flashMode keep $flashFreq keep $flashSize 16MB `
    0x10000 $resolved
if ($LASTEXITCODE -ne 0) {
    throw "esptool failed with exit code $LASTEXITCODE"
}

