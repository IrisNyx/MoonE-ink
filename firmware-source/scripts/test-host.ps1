param()

$ErrorActionPreference = "Stop"
$project = Split-Path -Parent $PSScriptRoot
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) {
    throw "Visual Studio locator not found: $vswhere"
}
$vs = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
if (-not $vs) {
    throw "A Visual Studio C++ toolchain is required for host tests."
}
$devShell = Join-Path $vs "Common7\Tools\Microsoft.VisualStudio.DevShell.dll"
Import-Module $devShell
Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments "-arch=x64 -host_arch=x64" | Out-Null

$outputDir = Join-Path $project ".pio\host-tests"
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$sleepExe = Join-Path $outputDir "battery-sleep-tests.exe"
& cl.exe /nologo /EHsc /W4 /WX /utf-8 /std:c++17 "/I$(Join-Path $project 'include')" (Join-Path $project 'tests\battery_sleep_tests.cpp') "/Fe:$sleepExe"
if ($LASTEXITCODE -ne 0) { throw "Battery sleep host test build failed" }
& $sleepExe
if ($LASTEXITCODE -ne 0) { throw "Battery sleep host tests failed" }
$sources = @(
    (Join-Path $project "tests\shell_core_tests.cpp"),
    (Join-Path $project "src\kernel\event_bus.cpp"),
    (Join-Path $project "src\kernel\app_manager.cpp"),
    (Join-Path $project "src\device\device_protocol.cpp"),
    (Join-Path $project "src\crypto\sha256.cpp"),
    (Join-Path $project "src\device\device_models.cpp"),
    (Join-Path $project "src\device\m5_interaction.cpp"),
    (Join-Path $project "src\device\remote_frame_cache.cpp"),
    (Join-Path $project "src\storage\device_state_repository.cpp"),
    (Join-Path $project "src\display\display_policy.cpp"),
    (Join-Path $project "src\display\display_manager.cpp"),
    (Join-Path $project "src\input\touch_transform.cpp"),
    (Join-Path $project "src\input\touch_manager.cpp"),
    (Join-Path $project "src\input\button_input.cpp")
    (Join-Path $project "src\input\shell_input.cpp")
)
$exe = Join-Path $outputDir "shell-core-tests.exe"
& cl.exe /nologo /EHsc /W4 /WX /utf-8 /std:c++17 "/I$(Join-Path $project 'include')" $sources "/Fe:$exe"
if ($LASTEXITCODE -ne 0) {
    throw "Host test build failed with exit code $LASTEXITCODE"
}
& $exe
if ($LASTEXITCODE -ne 0) {
    throw "Host tests failed with exit code $LASTEXITCODE"
}

$readerSources = @(
    (Join-Path $project "tests\reader_core_tests.cpp"),
    (Join-Path $project "src\reader\reader_core.cpp"),
    (Join-Path $project "src\reader\reader_progress.cpp")
)
$readerExe = Join-Path $outputDir "reader-core-tests.exe"
& cl.exe /nologo /EHsc /W4 /WX /utf-8 /std:c++17 "/I$(Join-Path $project 'include')" $readerSources "/Fe:$readerExe"
if ($LASTEXITCODE -ne 0) {
    throw "Reader host test build failed with exit code $LASTEXITCODE"
}
& $readerExe
if ($LASTEXITCODE -ne 0) {
    throw "Reader host tests failed with exit code $LASTEXITCODE"
}

$packageSources = @(
    (Join-Path $project "tests\package_policy_tests.cpp"),
    (Join-Path $project "src\packages\package_policy.cpp")
)
$packageExe = Join-Path $outputDir "package-policy-tests.exe"
& cl.exe /nologo /EHsc /W4 /WX /utf-8 /std:c++17 "/I$(Join-Path $project 'include')" $packageSources "/Fe:$packageExe"
if ($LASTEXITCODE -ne 0) {
    throw "Package policy host test build failed with exit code $LASTEXITCODE"
}
& $packageExe
if ($LASTEXITCODE -ne 0) {
    throw "Package policy host tests failed with exit code $LASTEXITCODE"
}

$packageSnapshotSources = @(
    (Join-Path $project "tests\package_snapshot_tests.cpp"),
    (Join-Path $project "src\packages\package_snapshot.cpp"),
    (Join-Path $project "src\packages\package_manifest_json.cpp"),
    (Join-Path $project "src\packages\package_registry.cpp"),
    (Join-Path $project "src\packages\package_policy.cpp"),
    (Join-Path $project "src\crypto\sha256.cpp")
)
$packageSnapshotExe = Join-Path $outputDir "package-snapshot-tests.exe"
& cl.exe /nologo /EHsc /W4 /WX /utf-8 /std:c++17 "/I$(Join-Path $project 'include')" $packageSnapshotSources "/Fe:$packageSnapshotExe"
if ($LASTEXITCODE -ne 0) {
    throw "Package snapshot host test build failed with exit code $LASTEXITCODE"
}
& $packageSnapshotExe
if ($LASTEXITCODE -ne 0) {
    throw "Package snapshot host tests failed with exit code $LASTEXITCODE"
}

$otaSources = @(
    (Join-Path $project "tests\ota_policy_tests.cpp"),
    (Join-Path $project "src\ota\ota_policy.cpp")
)
$otaExe = Join-Path $outputDir "ota-policy-tests.exe"
& cl.exe /nologo /EHsc /W4 /WX /utf-8 /std:c++17 "/I$(Join-Path $project 'include')" $otaSources "/Fe:$otaExe"
if ($LASTEXITCODE -ne 0) {
    throw "OTA policy host test build failed with exit code $LASTEXITCODE"
}
& $otaExe
if ($LASTEXITCODE -ne 0) {
    throw "OTA policy host tests failed with exit code $LASTEXITCODE"
}
