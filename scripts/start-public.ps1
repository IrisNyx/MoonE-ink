param(
  [ValidateRange(1, 65535)][int]$Port = 8765,
  [string]$LanAddress = '',
  [string]$Timezone = 'Asia/Shanghai'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$bundle = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$private = [IO.Path]::GetFullPath((Join-Path $bundle '..\ephemera-private'))
$data = Join-Path $private 'data'
$secrets = Join-Path $private 'secrets'
$browsers = Join-Path $private 'browsers'
$configPath = Join-Path $private 'config.json'
$authorSecretPath = Join-Path $secrets 'author-bearer.txt'
$ownerSecretPath = Join-Path $secrets 'owner-bearer.txt'
$entry = Join-Path $bundle 'dist\src\index.js'
$playwrightCli = Join-Path $bundle 'node_modules\playwright-core\cli.js'

if (!(Test-Path -LiteralPath $entry -PathType Leaf) -or !(Test-Path -LiteralPath $playwrightCli -PathType Leaf)) {
  throw 'The public bundle is incomplete. Extract the entire release archive first.'
}
if ($LanAddress -and $LanAddress -notmatch '^(?:\d{1,3}\.){3}\d{1,3}$') {
  throw 'LanAddress must be this computer LAN IPv4 address, such as 192.168.1.25.'
}

function New-Secret {
  $bytes = [byte[]]::new(32)
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($bytes) } finally { $random.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
function Secret-Hash([string]$value) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($value)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try { $digest = $sha256.ComputeHash($bytes) } finally { $sha256.Dispose() }
  return [BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant()
}

New-Item -ItemType Directory -Force -Path $private, $data, $secrets, $browsers | Out-Null
if (!(Test-Path -LiteralPath $configPath -PathType Leaf)) {
  $author = New-Secret
  $owner = New-Secret
  $hostAddress = if ($LanAddress) { '0.0.0.0' } else { '127.0.0.1' }
  $allowedHosts = @('localhost', '127.0.0.1', '[::1]')
  if ($LanAddress) { $allowedHosts += $LanAddress }
  $config = [ordered]@{
    server = [ordered]@{ host = $hostAddress; port = $Port; dataDir = $data; timezone = $Timezone; terminalPublishBudgetMs = 120000 }
    network = [ordered]@{ allowedHosts = $allowedHosts; allowedOrigins = @() }
    auth = [ordered]@{
      mode = 'static-bearer'; console_bearer_file = $authorSecretPath
      credentials = @([ordered]@{
        credential_id = 'cred_public_author'; caller_id = 'public_author';
        token_sha256 = Secret-Hash $author; tool_view = 'author'; revoked = $false
      })
    }
    deviceChannel = [ordered]@{
      enabled = $true; owner_token_sha256 = Secret-Hash $owner;
      channel_id = 'channel_public'; publisher_caller_ids = @('public_author')
    }
    logging = [ordered]@{ level = 'info' }
  }
  [IO.File]::WriteAllText($authorSecretPath, $author + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($ownerSecretPath, $owner + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  Write-Host "Created private configuration beside the release bundle: $private"
} else {
  $existing = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
  $Port = [int]$existing.server.port
  Write-Host "Using the existing private configuration: $configPath"
}

$browserCache = if ($env:PLAYWRIGHT_BROWSERS_PATH) { $env:PLAYWRIGHT_BROWSERS_PATH } else { $browsers }
$env:PLAYWRIGHT_BROWSERS_PATH = $browserCache
if (!(Test-Path -LiteralPath (Join-Path $browserCache 'chromium-1234')) -or
    !(Test-Path -LiteralPath (Join-Path $browserCache 'chromium_headless_shell-1234'))) {
  Write-Host 'Installing the renderer Chromium into the private directory...'
  & node $playwrightCli install chromium
  if ($LASTEXITCODE -ne 0) { throw 'Chromium installation failed; retry when the download is available.' }
}

Write-Host "Owner Console: http://127.0.0.1:$Port/console"
Write-Host "Owner Bearer file (keep private): $ownerSecretPath"
Write-Host 'Keep this window open while using Ephemera; press Ctrl+C to stop.'
Push-Location $bundle
try {
  & node $entry --config $configPath
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
