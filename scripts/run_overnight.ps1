[CmdletBinding()]
param(
  [string]$ResumeRunId
)

$ErrorActionPreference = 'Stop'
$integration = Split-Path $PSScriptRoot -Parent
$worktreeRoot = Split-Path $integration -Parent
if ([System.IO.Path]::GetPathRoot($worktreeRoot) -ne 'C:\') {
  throw 'Overnight worktrees, logs, and local storage must stay on C:.'
}

$codexCommand = Get-Command codex.cmd -ErrorAction Stop
$codexPath = $codexCommand.Source
$version = & $codexPath --version
if ($LASTEXITCODE -ne 0) { throw 'Codex CLI version check failed.' }

$mutex = [System.Threading.Mutex]::new($false, 'Local\LocaliseOvernightOrchestrator')
if (-not $mutex.WaitOne(0)) { throw 'Another Localise overnight orchestration run is active.' }

try {
  $runRootPath = Join-Path $worktreeRoot 'overnight-runs'
  New-Item -ItemType Directory -Force -Path $runRootPath | Out-Null
  if ($ResumeRunId) {
    if ($ResumeRunId -notmatch '^\d{8}-\d{6}$') { throw 'ResumeRunId must be a timestamped run ID.' }
    $runDir = Join-Path $runRootPath $ResumeRunId
    if (-not (Test-Path -LiteralPath $runDir -PathType Container)) { throw 'Requested run directory does not exist.' }
  } else {
    $runId = Get-Date -Format 'yyyyMMdd-HHmmss'
    $runDir = Join-Path $runRootPath $runId
    New-Item -ItemType Directory -Path $runDir | Out-Null
  }
  $runId = Split-Path $runDir -Leaf
  $logsDir = Join-Path $runDir 'logs'
  $statusDir = Join-Path $runDir 'agents'
  New-Item -ItemType Directory -Force -Path $logsDir, $statusDir | Out-Null

  $gitCommon = (& git -C $integration rev-parse --path-format=absolute --git-common-dir).Trim()
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $gitCommon -PathType Container)) {
    throw 'Unable to locate shared Git metadata for approved local commits.'
  }

  function Get-CDriveState {
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
    if (-not $disk) { throw 'Could not read C: free space.' }
    $free = [int64]$disk.FreeSpace
    $status = if ($free -lt 20GB) { 'pause-storage-intensive' } elseif ($free -lt 30GB) { 'warning' } else { 'normal' }
    [ordered]@{
      checked_at_utc = [DateTime]::UtcNow.ToString('o')
      drive = 'C:'
      free_bytes = $free
      free_gb = [Math]::Round($free / 1GB, 2)
      status = $status
      policy = 'warn below 30 GB; pause storage-intensive tasks below 20 GB'
    }
  }

  $storageStatePath = Join-Path $runDir 'storage-state.json'
  $storageLog = Join-Path $logsDir 'storage.jsonl'
  $initialDisk = Get-CDriveState
  $initialDisk | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $storageStatePath -Encoding utf8
  [ordered]@{ timestamp_utc = [DateTime]::UtcNow.ToString('o'); event = 'storage_check'; status = $initialDisk.status; free_gb = $initialDisk.free_gb } |
    ConvertTo-Json -Compress | Add-Content -LiteralPath $storageLog -Encoding utf8

  $statusPath = Join-Path $runDir 'run-status.json'
  [ordered]@{ run_id = $runId; status = 'running'; codex_cli = $version; started_at_utc = [DateTime]::UtcNow.ToString('o') } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statusPath -Encoding utf8

  $watcher = Start-Job -ArgumentList @($storageStatePath, $storageLog, $runDir) -ScriptBlock {
    param($StatePath, $LogPath, $RunDirectory)
    while (-not (Test-Path -LiteralPath (Join-Path $RunDirectory 'stop-storage-monitor'))) {
      try {
        $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
        $free = [int64]$disk.FreeSpace
        $status = if ($free -lt 20GB) { 'pause-storage-intensive' } elseif ($free -lt 30GB) { 'warning' } else { 'normal' }
        $state = [ordered]@{
          checked_at_utc = [DateTime]::UtcNow.ToString('o')
          drive = 'C:'
          free_bytes = $free
          free_gb = [Math]::Round($free / 1GB, 2)
          status = $status
          policy = 'warn below 30 GB; pause storage-intensive tasks below 20 GB'
        }
        $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StatePath -Encoding utf8
        [ordered]@{ timestamp_utc = [DateTime]::UtcNow.ToString('o'); event = 'storage_check'; status = $status; free_gb = $state.free_gb } |
          ConvertTo-Json -Compress | Add-Content -LiteralPath $LogPath -Encoding utf8
        if ($free -lt 30GB) {
          [ordered]@{ timestamp_utc = [DateTime]::UtcNow.ToString('o'); event = 'storage_warning'; status = $status; free_gb = $state.free_gb } |
            ConvertTo-Json -Compress | Add-Content -LiteralPath $LogPath -Encoding utf8
        }
        Start-Sleep -Seconds 900
      } catch {
        [ordered]@{ timestamp_utc = [DateTime]::UtcNow.ToString('o'); event = 'storage_monitor_error' } |
          ConvertTo-Json -Compress | Add-Content -LiteralPath $LogPath -Encoding utf8
        Start-Sleep -Seconds 900
      }
    }
  }

  $agentJob = {
    param($Name, $Branch, $Workspace, $TaskFile, $CodexPath, $GitCommon, $RunDirectory, $StorageStatePath, $MaxAttempts)
    $ErrorActionPreference = 'Continue'
    $checkpointDir = Join-Path $Workspace '.overnight'
    New-Item -ItemType Directory -Force -Path $checkpointDir | Out-Null
    $checkpointPath = Join-Path $checkpointDir 'progress.json'
    $statePath = Join-Path (Join-Path $RunDirectory 'agents') ($Name + '.json')
    $eventLog = Join-Path (Join-Path $RunDirectory 'logs') ($Name + '.jsonl')
    $attempt = 0
    $exitCode = 1
    while ($attempt -lt $MaxAttempts) {
      $attempt++
      $state = [ordered]@{
        agent = $Name
        branch = $Branch
        status = 'running'
        attempt = $attempt
        max_attempts = $MaxAttempts
        started_at_utc = [DateTime]::UtcNow.ToString('o')
        updated_at_utc = [DateTime]::UtcNow.ToString('o')
        checkpoint = $checkpointPath
      }
      $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding utf8
      [ordered]@{ timestamp_utc = [DateTime]::UtcNow.ToString('o'); agent = $Name; attempt = $attempt; event = 'started' } |
        ConvertTo-Json -Compress | Add-Content -LiteralPath $eventLog -Encoding utf8
      $prompt = "Read AGENTS.md and $TaskFile. Inspect the current branch and checkpoint $checkpointPath, then implement, test, debug, and review autonomously within assigned ownership. Commit tested local milestones. Do not push, deploy, access live services, or inspect credentials. Before storage-intensive work and every 15 minutes during collection, read $StorageStatePath; warn below 30 GB and pause storage-intensive operations below 20 GB while preserving checkpoints. Keep all work and data on C:. Do not download bulk photographs; retain URLs and license/attribution metadata."
      $env:GIT_CONFIG_COUNT = '1'
      $env:GIT_CONFIG_KEY_0 = 'safe.directory'
      $env:GIT_CONFIG_VALUE_0 = $Workspace
      $arguments = @(
        'exec', '--json',
        '--sandbox', 'workspace-write',
        '--ask-for-approval', 'never',
        '--add-dir', $GitCommon,
        '-C', $Workspace,
        $prompt
      )
      & $CodexPath @arguments 2>&1 | ForEach-Object {
        $eventType = 'non_json_output_suppressed'
        try {
          $eventObject = ([string]$_) | ConvertFrom-Json -ErrorAction Stop
          if ($eventObject.type) { $eventType = [string]$eventObject.type }
        } catch {}
        [ordered]@{
          timestamp_utc = [DateTime]::UtcNow.ToString('o')
          agent = $Name
          attempt = $attempt
          event = $eventType
        } | ConvertTo-Json -Compress | Add-Content -LiteralPath $eventLog -Encoding utf8
      }
      $exitCode = $LASTEXITCODE
      $head = (& git -C $Workspace rev-parse HEAD 2>$null)
      if ($LASTEXITCODE -ne 0) { $head = $null }
      $state.status = if ($exitCode -eq 0) { 'completed' } else { 'failed' }
      $state.exit_code = $exitCode
      $state.head = $head
      $state.updated_at_utc = [DateTime]::UtcNow.ToString('o')
      $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding utf8
      [ordered]@{ timestamp_utc = [DateTime]::UtcNow.ToString('o'); agent = $Name; attempt = $attempt; event = 'finished'; exit_code = $exitCode; head = $head } |
        ConvertTo-Json -Compress | Add-Content -LiteralPath $eventLog -Encoding utf8
      if ($exitCode -eq 0) { break }
      if ($attempt -lt $MaxAttempts) { Start-Sleep -Seconds 30 }
    }
    [pscustomobject]@{ agent = $Name; branch = $Branch; exit_code = $exitCode; status = $(if ($exitCode -eq 0) { 'completed' } else { 'failed' }) }
  }

  function Get-AgentState($Name) {
    $path = Join-Path $statusDir ($Name + '.json')
    if (Test-Path -LiteralPath $path) { return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json) }
    return $null
  }

  function Start-AgentPhase($Definitions, $PhaseName) {
    $jobs = @()
    foreach ($definition in $Definitions) {
      $existing = Get-AgentState $definition.Name
      if ($ResumeRunId -and $existing -and $existing.status -eq 'completed') { continue }
      $workspace = Join-Path $worktreeRoot $definition.Directory
      if (-not (Test-Path -LiteralPath $workspace -PathType Container)) {
        [ordered]@{ agent = $definition.Name; status = 'blocked'; reason = 'worktree_missing'; timestamp_utc = [DateTime]::UtcNow.ToString('o') } |
          ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $statusDir ($definition.Name + '.json')) -Encoding utf8
        continue
      }
      $actualBranch = (& git -C $workspace branch --show-current).Trim()
      if ($LASTEXITCODE -ne 0 -or $actualBranch -ne $definition.Branch) {
        throw "Branch validation failed for $($definition.Name)."
      }
      $taskFile = 'docs/tasks/' + $definition.Name + '.md'
      $jobs += Start-Job -Name $definition.Name -ArgumentList @(
        $definition.Name, $definition.Branch, $workspace, $taskFile, $codexPath, $gitCommon, $runDir, $storageStatePath, 2
      ) -ScriptBlock $agentJob
    }
    while (@($jobs | Where-Object { $_.State -eq 'Running' }).Count -gt 0) {
      Wait-Job -Job $jobs -Any -Timeout 30 | Out-Null
    }
    $results = @()
    foreach ($job in $jobs) {
      $results += Receive-Job -Job $job
      Remove-Job -Job $job
    }
    [ordered]@{ phase = $PhaseName; completed_at_utc = [DateTime]::UtcNow.ToString('o'); results = $results }
  }

  $featureDefinitions = @(
    @{ Name = 'backend'; Branch = 'dev/backend'; Directory = 'backend' },
    @{ Name = 'tourism-data'; Branch = 'dev/tourism-data'; Directory = 'tourism-data' },
    @{ Name = 'frontend'; Branch = 'dev/frontend'; Directory = 'frontend' },
    @{ Name = 'itinerary'; Branch = 'dev/itinerary'; Directory = 'itinerary' },
    @{ Name = 'qa'; Branch = 'dev/qa'; Directory = 'qa' }
  )
  $integrationDefinition = @(
    @{ Name = 'integration'; Branch = 'dev/integration'; Directory = 'integration' }
  )

  $featurePhase = Start-AgentPhase $featureDefinitions 'feature-agents-parallel'
  $featurePhase | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDir 'feature-phase.json') -Encoding utf8
  $integrationPhase = Start-AgentPhase $integrationDefinition 'integration-coordinator'
  $integrationPhase | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDir 'integration-phase.json') -Encoding utf8

  New-Item -ItemType File -Force -Path (Join-Path $runDir 'stop-storage-monitor') | Out-Null
  Stop-Job $watcher -ErrorAction SilentlyContinue
  Receive-Job $watcher -ErrorAction SilentlyContinue | Out-Null
  Remove-Job $watcher -ErrorAction SilentlyContinue

  $finalDisk = Get-CDriveState
  $agentSummary = @()
  foreach ($definition in (@($featureDefinitions) + @($integrationDefinition))) {
    $state = Get-AgentState $definition.Name
    $workspace = Join-Path $worktreeRoot $definition.Directory
    $head = $null
    if (Test-Path -LiteralPath $workspace) {
      $head = (& git -C $workspace rev-parse HEAD 2>$null)
      if ($LASTEXITCODE -ne 0) { $head = $null }
    }
    $agentSummary += [ordered]@{
      agent = $definition.Name
      branch = $definition.Branch
      status = if ($state) { $state.status } else { 'not_started' }
      head = $head
      checkpoint = if ($state) { $state.checkpoint } else { $null }
    }
  }
  $summary = [ordered]@{
    run_id = $runId
    finished_at_utc = [DateTime]::UtcNow.ToString('o')
    status = if (@($agentSummary | Where-Object { $_.status -ne 'completed' }).Count -eq 0) { 'completed' } else { 'incomplete' }
    storage = [ordered]@{ initial = $initialDisk; final = $finalDisk; state_file = $storageStatePath; log = $storageLog }
    agents = $agentSummary
    logs_directory = $logsDir
    note = 'Agent event logs contain timestamps and event types only; review task checkpoints and Git diffs for details.'
  }
  $summary | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $runDir 'morning-summary.json') -Encoding utf8
  [ordered]@{ run_id = $runId; status = $summary.status; summary = (Join-Path $runDir 'morning-summary.json') } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statusPath -Encoding utf8
  $summary | ConvertTo-Json -Depth 10
} finally {
  if ($watcher -and $watcher.State -eq 'Running') {
    New-Item -ItemType File -Force -Path (Join-Path $runDir 'stop-storage-monitor') | Out-Null
    Stop-Job $watcher -ErrorAction SilentlyContinue
    Remove-Job $watcher -ErrorAction SilentlyContinue
  }
  if ($mutex) { $mutex.ReleaseMutex(); $mutex.Dispose() }
}
