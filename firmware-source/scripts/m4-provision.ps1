param(
    [Parameter(Mandatory = $true)]
    [string]$SessionFile,
    [string]$Port = "COM7",
    [int]$TimeoutSeconds = 90,
    [int]$MonitorSeconds = 0
)

$ErrorActionPreference = "Stop"
$session = Get-Content -Raw -LiteralPath $SessionFile | ConvertFrom-Json
if ($session.schema_version -ne 1 -or -not $session.endpoint -or
    -not $session.enrollment_code -or -not $session.device_id) {
    throw "M4 session file is invalid."
}

$ssid = Read-Host "Wi-Fi SSID (2.4 GHz)"
$securePassword = Read-Host "Wi-Fi password (input is hidden)" -AsSecureString
$password = [System.Net.NetworkCredential]::new("", $securePassword).Password
$payload = @{
    type = "m4_provision"
    wifi_ssid = $ssid
    wifi_password = $password
    endpoint = [string]$session.endpoint
    enrollment_code = [string]$session.enrollment_code
    device_id = [string]$session.device_id
    unix_time = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
} | ConvertTo-Json -Compress

$link = [System.IO.Ports.SerialPort]::new($Port, 115200, 'None', 8, 'One')
$link.NewLine = "`n"
$link.ReadTimeout = 250
$link.WriteTimeout = 5000
try {
    $link.Open()
    $link.DtrEnable = $false
    $link.RtsEnable = $true
    Start-Sleep -Milliseconds 100
    $link.RtsEnable = $false
    Start-Sleep -Seconds 6
    $link.WriteLine($payload)
    $payload = $null
    $password = $null
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $firstLightPassed = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $line = $link.ReadLine()
            if ($line) {
                Write-Host $line
                if ($line -match '\[M4\] first_light=PASS') {
                    $firstLightPassed = $true
                    break
                }
                if ($line -match '\[M4\] command=FAIL') { throw "M4 first light failed." }
            }
        } catch [System.TimeoutException] {
        }
    }
    if (-not $firstLightPassed) { throw "Timed out waiting for M4 first light." }

    if ($MonitorSeconds -gt 0) {
        Write-Host "[HOST] physical-input-monitor=READY duration_seconds=$MonitorSeconds"
        $monitorDeadline = [DateTime]::UtcNow.AddSeconds($MonitorSeconds)
        while ([DateTime]::UtcNow -lt $monitorDeadline) {
            try {
                $line = $link.ReadLine()
                if ($line) { Write-Host $line }
            } catch [System.TimeoutException] {
            }
        }
        Write-Host "[HOST] physical-input-monitor=COMPLETE"
    }

    # Optional service controls. Provisioning is already durable in device NVS;
    # closing this fallback terminal no longer loses Wi-Fi or binding state.
    Write-Host "[HOST] controls=READY commands=s(settings),e(ephemera),p(previous_page),n(next_page),h(previous_publication),j(next_publication),l(return_latest),a(acknowledge),1..6(system-menu touch),q(quit)"
    while ($true) {
        $choice = (Read-Host "M4 control").Trim().ToLowerInvariant()
        if ($choice -eq 'q') { break }
        $showApps = @{ s = 'settings'; e = 'ephemera' }
        $actions = @{
            p = 'previous_page'
            n = 'next_page'
            h = 'previous_publication'
            j = 'next_publication'
            l = 'return_latest'
            a = 'acknowledge'
        }
        $touches = @{
            '1' = @{ x = 147; y = 312; action = 'previous_page' }
            '2' = @{ x = 392; y = 312; action = 'next_page' }
            '3' = @{ x = 147; y = 468; action = 'previous_publication' }
            '4' = @{ x = 392; y = 468; action = 'next_publication' }
            '5' = @{ x = 147; y = 624; action = 'return_latest' }
            '6' = @{ x = 392; y = 624; action = 'acknowledge' }
        }
        if (-not $showApps.ContainsKey($choice) -and
            -not $actions.ContainsKey($choice) -and
            -not $touches.ContainsKey($choice)) {
            Write-Host "[HOST] control=REJECTED"
            continue
        }
        if ($showApps.ContainsKey($choice)) {
            $app = $showApps[$choice]
            $command = @{ type = 'm4_show'; app = $app } | ConvertTo-Json -Compress
            $successPattern = "\[M4\] show=$([regex]::Escape($app)).*PASS"
        } elseif ($actions.ContainsKey($choice)) {
            $app = $actions[$choice]
            $command = @{ type = 'm5_action'; action = $app } | ConvertTo-Json -Compress
            $successPattern = if ($app -eq 'acknowledge') {
                '\[M5\] acknowledge=PASS'
            } else {
                "\[M5\] present=PASS action=$([regex]::Escape($app))"
            }
        } else {
            $point = $touches[$choice]
            $app = $point.action
            $command = @{ type = 'm5_touch'; x = $point.x; y = $point.y } | ConvertTo-Json -Compress
            $successPattern = if ($app -eq 'acknowledge') {
                '\[M5\] acknowledge=PASS'
            } else {
                "\[M5\] present=PASS action=$([regex]::Escape($app))"
            }
        }
        $link.WriteLine($command)
        # Cross-publication actions can perform two full e-paper refreshes plus
        # bounded HTTP receipt flushes on weak 2.4 GHz links.
        $commandDeadline = [DateTime]::UtcNow.AddSeconds(60)
        $completed = $false
        while ([DateTime]::UtcNow -lt $commandDeadline) {
            try {
                $line = $link.ReadLine()
                if ($line) {
                    Write-Host $line
                    if ($line -match $successPattern) {
                        $completed = $true
                        break
                    }
                    if ($line -match '\[M4\] command=FAIL') { throw "M4 $app display command failed." }
                }
            } catch [System.TimeoutException] {
            }
        }
        if (-not $completed) { throw "Timed out waiting for M4 $app display command." }
    }
} finally {
    $payload = $null
    $password = $null
    $securePassword = $null
    if ($link.IsOpen) { $link.Close() }
    $link.Dispose()
}

