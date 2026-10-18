# Configures Hermes to use the local ChatGPT Web bridge for all LLM tasks.
# Accepts existing named codex-web providers or installs a new one. Never logs credentials.
param(
  [string]$ConfigPath,
  [int]$ContextWindow = 120000,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
if (!$ConfigPath) {
  $hermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME }
    elseif (Test-Path (Join-Path $env:LOCALAPPDATA 'hermes/config.yaml')) { Join-Path $env:LOCALAPPDATA 'hermes' }
    else { Join-Path $env:USERPROFILE '.hermes' }
  $ConfigPath = Join-Path $hermesHome 'config.yaml'
}
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
if (!(Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
  throw "Hermes config.yaml not found at $ConfigPath. Install Hermes first, then run this script again."
}
$original = [IO.File]::ReadAllText($ConfigPath)
$newline = if ($original.Contains(([string][char]13 + [char]10))) { [string][char]13 + [char]10 } else { [string][char]10 }
$bridge = 'http://127.0.0.1:17941/v1'
$model = 'chatgpt-web/gpt-6-sol'

function Set-Field([string]$body, [string]$indent, [string]$name, [string]$value) {
  $pattern = '(?m)^' + [regex]::Escape($indent + $name + ':') + '[^\r\n]*'
  $matches = [regex]::Matches($body, $pattern)
  if ($matches.Count -gt 1) { throw "Duplicate YAML key: $name" }
  $line = $indent + $name + ': ' + $value
  if ($matches.Count -eq 1) { return [regex]::Replace($body, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $line }) }
  return $body.TrimEnd([char]13, [char]10) + $newline + $line + $newline
}

function Find-RootBlock([string]$yaml, [string]$key) {
  return [regex]::Match($yaml, ('(?ms)^' + [regex]::Escape($key) + ':\r?\n.*?(?=^[a-zA-Z_][a-zA-Z0-9_-]*:|\z)'))
}

$main = Find-RootBlock $original 'model'
if (!$main.Success) { throw 'Cannot find a root model: block in Hermes config.yaml' }
$body = $main.Value
foreach ($pair in @(
  @('provider', 'codex-web'), @('default', $model), @('base_url', $bridge),
  @('api_mode', 'chat_completions'), @('context_length', [string]$ContextWindow),
  @('supports_vision', 'true')
)) { $body = Set-Field $body '  ' $pair[0] $pair[1] }
$updated = $original.Substring(0, $main.Index) + $body + $original.Substring($main.Index + $main.Length)

# Replace only the fork-owned provider definition; leave every other custom provider alone.
$providerBlock = @(
  '  codex-web:',
  '    name: ChatGPT Web Bridge',
  "    api: $bridge",
  '    api_key: no-key-required',
  '    transport: chat_completions',
  "    default_model: $model",
  '    session_affinity_header: x-codex-thread-id',
  '    discover_models: true',
  '    models:',
  "      ${model}:",
  '        display_name: GPT-6 Sol (Web)',
  "        context_length: $ContextWindow",
  '        supports_vision: true'
) -join $newline
$providerBlock += $newline
$existingProvider = [regex]::Match($updated, '(?ms)^  codex-web:\r?\n.*?(?=^  [A-Za-z0-9_-]+:\r?\n|^[A-Za-z_][A-Za-z0-9_-]*:|\z)')
if ($existingProvider.Success) {
  $updated = $updated.Substring(0, $existingProvider.Index) + $providerBlock +
    $updated.Substring($existingProvider.Index + $existingProvider.Length)
} else {
  $providers = [regex]::Match($updated, '(?ms)^providers:(?: \{\})?\r?\n.*?(?=^[A-Za-z_][A-Za-z0-9_-]*:|\z)')
  if (!$providers.Success) { throw 'Cannot find a root providers: block in Hermes config.yaml' }
  $providersBody = [regex]::Replace($providers.Value, '^providers: \{\}', 'providers:')
  $providersBody = $providersBody.TrimEnd([char]13, [char]10) + $newline + $providerBlock
  $updated = $updated.Substring(0, $providers.Index) + $providersBody +
    $updated.Substring($providers.Index + $providers.Length)
}

$fallback = [regex]::Match($updated, '(?ms)^fallback_providers:[^\r\n]*\r?\n.*?(?=^[A-Za-z_][A-Za-z0-9_-]*:|\z)')
if ($fallback.Success) {
  $updated = $updated.Substring(0, $fallback.Index) + 'fallback_providers: []' + $newline +
    $updated.Substring($fallback.Index + $fallback.Length)
} elseif ([regex]::IsMatch($updated, '(?m)^fallback_providers: \[\]')) {
  # Already disabled.
} else {
  $updated += $newline + 'fallback_providers: []' + $newline
}

$agent = Find-RootBlock $updated 'agent'
if (!$agent.Success) { throw 'Cannot find agent: block in Hermes config.yaml' }
$agentBody = Set-Field $agent.Value '  ' 'image_input_mode' 'native'
$updated = $updated.Substring(0, $agent.Index) + $agentBody + $updated.Substring($agent.Index + $agent.Length)

$aux = Find-RootBlock $updated 'auxiliary'
if (!$aux.Success) { throw 'Cannot find auxiliary: block in Hermes config.yaml' }
$auxBody = $aux.Value
$tasks = @([regex]::Matches($auxBody, '(?m)^  ([a-z_]+):\r?$') | ForEach-Object { $_.Groups[1].Value })
if ($tasks.Count -eq 0) { throw 'No auxiliary tasks were found; refusing to silently skip them' }
foreach ($task in $tasks) {
  $slot = [regex]::Match($auxBody, ('(?ms)^  ' + [regex]::Escape($task) + ':\r?\n.*?(?=^  [a-z_]+:|\z)'))
  if (!$slot.Success) { throw "Cannot find auxiliary task: $task" }
  $slotBody = $slot.Value
  foreach ($pair in @(
    @('provider', 'codex-web'), @('model', $model), @('base_url', $bridge), @('api_key', 'no-key-required')
  )) { $slotBody = Set-Field $slotBody '    ' $pair[0] $pair[1] }
  $auxBody = $auxBody.Substring(0, $slot.Index) + $slotBody + $auxBody.Substring($slot.Index + $slot.Length)
}
$updated = $updated.Substring(0, $aux.Index) + $auxBody + $updated.Substring($aux.Index + $aux.Length)
if ($updated -notmatch '(?m)^fallback_providers: \[\]') { throw 'External fallback was not disabled' }

Write-Output "Hermes profile: $ConfigPath"
Write-Output "Model: $model / vision: native / auxiliary routes: $($tasks.Count)"
if ($DryRun) { Write-Output 'Validation mode: no files changed'; exit 0 }
if ($updated -eq $original) { Write-Output 'Configuration already matches; no write required'; exit 0 }
$backup = $ConfigPath + '.bak-gpt6-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
[IO.File]::WriteAllText($backup, $original, [Text.UTF8Encoding]::new($false))
try {
  [IO.File]::WriteAllText($ConfigPath, $updated, [Text.UTF8Encoding]::new($false))
  if ([IO.File]::ReadAllText($ConfigPath) -ne $updated) { throw 'Config read-back mismatch' }
} catch {
  [IO.File]::WriteAllText($ConfigPath, $original, [Text.UTF8Encoding]::new($false))
  throw
}
Write-Output "Original config backup: $backup"
