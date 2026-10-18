# Windows setup for the fork bridge. Does not replace the official launcher.
param([switch]$CheckOnly, [switch]$SkipHermes, [switch]$NoStart)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This installer supports Windows. Use scripts/serve-harness.ts directly on other systems.' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$service = Join-Path $repo 'scripts/serve-harness.ts'
$configScript = Join-Path $repo 'scripts/configure-hermes-gpt6.ps1'
if (!(Test-Path -LiteralPath $service) -or !(Test-Path -LiteralPath $configScript)) { throw 'Repository checkout incomplete; clone the fork again.' }

function Find-Bun {
  $cli = Get-Command bun -ErrorAction SilentlyContinue
  if ($cli -and (Test-Path -LiteralPath $cli.Source)) { return $cli.Source }
  $npm = Join-Path $env:APPDATA 'npm/node_modules/bun/bin/bun.exe'
  if (Test-Path -LiteralPath $npm) { return $npm }
  $versions = Join-Path $env:USERPROFILE '.codex-chatgpt-web/versions'
  if (Test-Path -LiteralPath $versions) {
    foreach ($v in @(Get-ChildItem -LiteralPath $versions -Directory | Sort-Object Name -Descending)) {
      $bundled = Join-Path $v.FullName 'runtime/bun.exe'
      if (Test-Path -LiteralPath $bundled) { return $bundled }
    }
  }
  return $null
}
$bun = Find-Bun
if (!$bun) { throw 'Bun was not found. Install Bun (https://bun.sh/docs/installation) and retry.' }
$launcherPath = Join-Path $env:USERPROFILE '.codex-chatgpt-web/config.json'
if (!(Test-Path -LiteralPath $launcherPath)) { throw 'Official ChatGPT Web launcher missing: install it, sign in and enable Full harness.' }
$launcher = Get-Content -LiteralPath $launcherPath -Raw | ConvertFrom-Json
if ($launcher.mode -ne 'full' -or $launcher.browserHost -ne 'launcher') { throw 'Enable Full harness in the official launcher before installing this bridge.' }

$hermesPath = if ($env:HERMES_HOME) { Join-Path $env:HERMES_HOME 'config.yaml' }
  elseif (Test-Path (Join-Path $env:LOCALAPPDATA 'hermes/config.yaml')) { Join-Path $env:LOCALAPPDATA 'hermes/config.yaml' }
  else { Join-Path $env:USERPROFILE '.hermes/config.yaml' }
if (!$SkipHermes -and !(Test-Path -LiteralPath $hermesPath)) { throw "Hermes config.yaml not found: $hermesPath. Install Hermes or use -SkipHermes for another harness." }

Write-Output "Fork: $repo"
Write-Output "Bun: $bun"
Write-Output 'Official launcher: Full harness'
Write-Output 'Bridge: http://127.0.0.1:17941/v1'
if (!$SkipHermes) {
  & $configScript -ConfigPath $hermesPath -DryRun
  if (!$?) { throw 'Hermes configuration check failed' }
}
if ($CheckOnly) { Write-Output 'Prerequisites OK. Run without -CheckOnly to install.'; exit 0 }

if (!(Test-Path -LiteralPath (Join-Path $repo 'node_modules'))) {
  Write-Output 'Installing locked dependencies...'
  Push-Location $repo
  try {
    & $bun install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'bun install failed' }
  } finally { Pop-Location }
}
if (!$SkipHermes) {
  & $configScript -ConfigPath $hermesPath
  if (!$?) { throw 'Hermes configuration failed' }
}

$taskName = 'Codex Web Harness Bridge'
$args = 'run "' + $service + '"'
$action = New-ScheduledTaskAction -Execute $bun -Argument $args -WorkingDirectory $repo
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$same = $false
if ($existing) {
  $a = @($existing.Actions)[0]
  $same = $a.Execute -eq $bun -and $a.Arguments -eq $args -and $a.WorkingDirectory -eq $repo
}
if (!$same) {
  $health = $null
  try { $health = Invoke-RestMethod 'http://127.0.0.1:17941/healthz' -TimeoutSec 3 } catch {}
  if ($health -and ($health.active_http_turns -gt 0 -or $health.active_browser_turns -gt 0)) { throw 'Bridge has active requests; retry after the turn finishes.' }
  if ($existing -and $existing.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName }
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Write-Output "Autostart registered: $taskName"
} else {
  Write-Output "Autostart already present: $taskName"
}

if (!$NoStart) {
  $task = Get-ScheduledTask -TaskName $taskName
  if ($task.State -ne 'Running') { Start-ScheduledTask -TaskName $taskName }
  $ready = $false
  for ($i=0; $i -lt 18; $i++) {
    Start-Sleep -Seconds 1
    try {
      $h = Invoke-RestMethod 'http://127.0.0.1:17941/healthz' -TimeoutSec 3
      if ($h.status -eq 'ok') { $ready = $true; break }
    } catch {}
  }
  if (!$ready) { throw 'Bridge did not become healthy. Check launcher Full mode and scheduled task history.' }
  $catalog = Invoke-RestMethod 'http://127.0.0.1:17941/v1/models' -Headers @{ Authorization = 'Bearer no-key-required' } -TimeoutSec 10
  if (@($catalog.data | Where-Object id -eq 'chatgpt-web/gpt-6-sol').Count -eq 0) { throw 'Bridge is online but GPT-6 Sol is unavailable.' }
  Write-Output 'Bridge healthy: GPT-6 Sol is available at port 17941'
}
Write-Output 'Installation complete. Restart Hermes to use GPT-6 for conversation, images and auxiliary tasks.'
