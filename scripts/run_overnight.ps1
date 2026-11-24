[CmdletBinding()]
param([string]$ResumeRunId)

$ErrorActionPreference = 'Stop'
$integration = Split-Path $PSScriptRoot -Parent
$worktreeRoot = Split-Path $integration -Parent
if ([System.IO.Path]::GetPathRoot($worktreeRoot) -ne 'C:\') {
  throw 'Overnight worktrees, logs, and local storage must stay on C:.'
}

$codexPath = (Get-Command codex.cmd -ErrorAction Stop).Source
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$codexVersion = & $codexPath --version
if ($LASTEXITCODE -ne 0) { throw 'Codex CLI version check failed.' }

$mutex = [System.Threading.Mutex]::new($false, 'Local\LocaliseOvernightOrchestrator')
if (-not $mutex.WaitOne(0)) { throw 'Another Localise overnight orchestration run is active.' }
$watcher = $null

try {
  $runRoot = Join-Path $worktreeRoot 'overnight-runs'
  New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
  if ($ResumeRunId) {
    if ($ResumeRunId -notmatch '^\d{8}-\d{6}$') { throw 'ResumeRunId must be a timestamped run ID.' }
    $runDir = Join-Path $runRoot $ResumeRunId
    if (-not (Test-Path -LiteralPath $runDir -PathType Container)) { throw 'Requested run directory does not exist.' }
  } else {
    $runId = Get-Date -Format 'yyyyMMdd-HHmmss'
    $runDir = Join-Path $runRoot $runId
    New-Item -ItemType Directory -Path $runDir | Out-Null
  }
  $runId = Split-Path $runDir -Leaf
  $logsDir = Join-Path $runDir 'logs'
  $agentsDir = Join-Path $runDir 'agents'
  New-Item -ItemType Directory -Force -Path $logsDir, $agentsDir | Out-Null

  $gitCommon = (& git -c "safe.directory=$integration" -C $integration rev-parse --path-format=absolute --git-common-dir).Trim()
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $gitCommon -PathType Container)) {
    throw 'Unable to locate shared Git metadata for approved local commits.'
  }

  function Get-CDriveState {
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
    if (-not $disk) { throw 'Could not read C: free space.' }
    $free = [int64]$disk.FreeSpace
    $state = if ($free -lt 20GB) { 'pause-storage-intensive' } elseif ($free -lt 30GB) { 'warning' } else { 'normal' }
    [ordered]@{
      checked_at_utc = [DateTime]::UtcNow.ToString('o')
      drive = 'C:'
      free_bytes = $free
      free_gb = [Math]::Round($free / 1GB, 2)
      status = $state
      policy = 'warn below 30 GB; pause storage-intensive tasks below 20 GB'
    }
  }

  $storageStatePath = Join-Path $runDir 'storage-state.json'
  $stopStoragePath = Join-Path $runDir ('stop-storage-monitor-' + $PID)
  $storageLog = Join-Path $logsDir 'storage.jsonl'
  $initialDisk = Get-CDriveState
  $initialDisk | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $storageStatePath -Encoding utf8
  [ordered]@{ timestamp_utc = [DateTime]::UtcNow.ToString('o'); event = 'storage_check'; status = $initialDisk.status; free_gb = $initialDisk.free_gb } |
    ConvertTo-Json -Compress | Add-Content -LiteralPath $storageLog -Encoding utf8

  $statusPath = Join-Path $runDir 'run-status.json'
  $runStarted = [DateTime]::UtcNow.ToString('o')
  if (Test-Path -LiteralPath $statusPath) {
    try {
      $priorRun = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
      if ($priorRun.started_at_utc) { $runStarted = [string]$priorRun.started_at_utc }
    } catch {}
  }
  [ordered]@{ run_id = $runId; status = 'running'; codex_cli = $codexVersion; started_at_utc = $runStarted } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statusPath -Encoding utf8

  $dashboardScript = Join-Path $PSScriptRoot 'mission_control.mjs'
  if (-not (Test-Path -LiteralPath $dashboardScript -PathType Leaf)) { throw 'Mission Control server script is missing.' }
  $dashboardStatusPath = Join-Path $runDir 'dashboard-status.json'
  $dashboardInfo = $null
  if (Test-Path -LiteralPath $dashboardStatusPath) {
    try {
      $oldDashboard = Get-Content -LiteralPath $dashboardStatusPath -Raw | ConvertFrom-Json
      if ($oldDashboard.status -eq 'ready') {
        try { $null = Get-Process -Id ([int]$oldDashboard.pid) -ErrorAction Stop; $dashboardInfo = $oldDashboard } catch {}
      }
    } catch {}
  }
  if (-not $dashboardInfo) {
    $port = $null
    for ($candidatePort = 8789; $candidatePort -le 8798; $candidatePort++) {
      $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $candidatePort)
      try { $probe.Start(); $probe.Stop(); $port = $candidatePort; break } catch { try { $probe.Stop() } catch {} }
    }
    if (-not $port) { throw 'No free localhost dashboard port in 8789-8798.' }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $dashboardOut = Join-Path $logsDir ('dashboard-' + $stamp + '.stdout.log')
    $dashboardErr = Join-Path $logsDir ('dashboard-' + $stamp + '.stderr.log')
    $dashboardArguments = '"{0}" "{1}" "{2}" {3}' -f $dashboardScript, $runDir, $worktreeRoot, $port
    $dashboardProcess = Start-Process -FilePath $nodePath -ArgumentList $dashboardArguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $dashboardOut -RedirectStandardError $dashboardErr
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 500
      if (Test-Path -LiteralPath $dashboardStatusPath) {
        try {
          $candidate = Get-Content -LiteralPath $dashboardStatusPath -Raw | ConvertFrom-Json
          if ($candidate.status -eq 'ready' -and [int]$candidate.pid -eq $dashboardProcess.Id) { $dashboardInfo = $candidate; break }
        } catch {}
      }
      $dashboardProcess.Refresh()
      if ($dashboardProcess.HasExited) { break }
    }
    if (-not $dashboardInfo) {
      [ordered]@{ timestamp_utc = [DateTime]::UtcNow.ToString('o'); event = 'dashboard_unavailable'; logs = 'timestamped dashboard stderr log' } |
        ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $logsDir 'orchestrator.jsonl') -Encoding utf8
    }
  }
  if ($dashboardInfo) {
    $dashboardUrl = [string]$dashboardInfo.url
    $dashboardPid = [int]$dashboardInfo.pid
  } else {
    $dashboardUrl = $null
    $dashboardPid = $null
  }
  [ordered]@{ run_id = $runId; status = 'running'; codex_cli = $codexVersion; started_at_utc = $runStarted; dashboard_url = $dashboardUrl; dashboard_pid = $dashboardPid } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statusPath -Encoding utf8
  Write-Output ('Mission Control: ' + $dashboardUrl)

  $watcher = Start-Job -ArgumentList @($storageStatePath, $storageLog, $stopStoragePath) -ScriptBlock {
    param($StatePath, $LogPath, $StopPath)
    while (-not (Test-Path -LiteralPath $StopPath)) {
      try {
        $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
        $free = [int64]$disk.FreeSpace
        $status = if ($free -lt 20GB) { 'pause-storage-intensive' } elseif ($free -lt 30GB) { 'warning' } else { 'normal' }
        $state = [ordered]@{ checked_at_utc = [DateTime]::UtcNow.ToString('o'); drive = 'C:'; free_bytes = $free; free_gb = [Math]::Round($free / 1GB,2); status = $status; policy = 'warn below 30 GB; pause storage-intensive tasks below 20 GB' }
        $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StatePath -Encoding utf8
        [ordered]@{ timestamp_utc = [DateTime]::UtcNow.ToString('o'); event = 'storage_check'; status = $status; free_gb = $state.free_gb } |
          ConvertTo-Json -Compress | Add-Content -LiteralPath $LogPath -Encoding utf8
        if ($free -lt 30GB) {
          [ordered]@{ timestamp_utc = [DateTime]::UtcNow.ToString('o'); event = 'storage_warning'; status = $status; free_gb = $state.free_gb } |
            ConvertTo-Json -Compress | Add-Content -LiteralPath $LogPath -Encoding utf8
        }
      } catch {
        [ordered]@{ timestamp_utc = [DateTime]::UtcNow.ToString('o'); event = 'storage_monitor_error' } |
          ConvertTo-Json -Compress | Add-Content -LiteralPath $LogPath -Encoding utf8
      }
      Start-Sleep -Seconds 900
    }
  }

  $agentJob = {
    param($Name, $Branch, $Workspace, $TaskFile, $CodexPath, $GitCommon, $RunDirectory, $StoragePath, $MaxRetries, $MaxTurns)
    $ErrorActionPreference = 'Continue'
    $checkpointDir = Join-Path $Workspace '.overnight'
    New-Item -ItemType Directory -Force -Path $checkpointDir | Out-Null
    $checkpointPath = Join-Path $checkpointDir 'progress.json'
    $statePath = Join-Path (Join-Path $RunDirectory 'agents') ($Name + '.json')
    $eventLog = Join-Path (Join-Path $RunDirectory 'logs') ($Name + '.jsonl')
    $retryCount = 0
    $turn = 0
    $firstStarted = [DateTime]::UtcNow.ToString('o')
    $lastSignature = 'missing'
    $stalls = 0
    $previousStatus = ''
    if (Test-Path -LiteralPath $statePath) {
      try {
        $previous = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ($previous.retry_attempts -ne $null) { $retryCount = [int]$previous.retry_attempts }
        if ($previous.turn -ne $null) { $turn = [int]$previous.turn }
        if ($previous.first_started_at_utc) { $firstStarted = [string]$previous.first_started_at_utc }
        if ($previous.progress_signature) { $lastSignature = [string]$previous.progress_signature }
        if ($previous.no_progress_turns -ne $null) { $stalls = [int]$previous.no_progress_turns }
        if ($previous.status) { $previousStatus = [string]$previous.status }
      } catch {}
    }
    $exitCode = 1
    $status = 'in_progress'
    $done = $false
    if ($retryCount -ge $MaxRetries -and $previousStatus -eq 'failed') { $status = 'failed'; $done = $true }
    while ($turn -lt $MaxTurns -and -not $done) {
      $turn++
      $attempt = $retryCount + 1
      $state = [ordered]@{
        agent = $Name
        branch = $Branch
        status = 'running'
        attempt = $attempt
        retry_attempts = $retryCount
        max_retries = $MaxRetries
        turn = $turn
        max_turns = $MaxTurns
        started_at_utc = [DateTime]::UtcNow.ToString('o')
        first_started_at_utc = $firstStarted
        process_id = $PID
        runner_pid = $PID
        codex_process_ids = @()
        updated_at_utc = [DateTime]::UtcNow.ToString('o')
        checkpoint = $checkpointPath
        progress_signature = $lastSignature
        no_progress_turns = $stalls
      }
      $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding utf8
      [ordered]@{ timestamp_utc = [DateTime]::UtcNow.ToString('o'); agent = $Name; attempt = $attempt; turn = $turn; event = 'started' } |
        ConvertTo-Json -Compress | Add-Content -LiteralPath $eventLog -Encoding utf8

      $prompt = "Read AGENTS.md and $TaskFile. Continue the assigned task from checkpoint $checkpointPath and current worktree. Implement, test, debug, and review autonomously within ownership. Commit tested local milestones. Update checkpoint JSON using agent, status, completed, current, milestones, tests, commits, next, blockers, errors, metrics, updated_at_utc. Use status completed only when acceptance criteria and tests are complete; use in_progress to continue next turn, and paused/blocked only for a genuine blocker. Each completed milestone needs status=completed and an evidence file path relative to the worktree. Each metric is an object with value, verified, mock, and relative evidence path; verified=true only for locally verified results and mock=false only for real isolated local data. Mock data has mock=true and never counts as collected. Test rows include name, result, and relative evidence path. Do not push, deploy, access live services, or inspect credentials. Before storage-intensive work and every 15 minutes during collection, read $StoragePath; warn below 30 GB and pause storage-intensive work below 20 GB while preserving checkpoints. Keep all work/data on C:. Do not download bulk photographs; retain URLs and license/attribution metadata."
      $env:GIT_CONFIG_COUNT = '1'
      $env:GIT_CONFIG_KEY_0 = 'safe.directory'
      $env:GIT_CONFIG_VALUE_0 = $Workspace
      $argsForCodex = @('exec','--json','--approve-for-me','--config','sandbox_workspace_write.network_access=true','-C',$Workspace,$prompt)

      & $CodexPath @argsForCodex 2>&1 | ForEach-Object {
        $line = [string]$_
        $eventType = 'non_json_output_suppressed'
        if ($line -match 'value is required|requires a value') { $eventType = 'cli_missing_argument' }
        elseif ($line -match 'unrecognized option|unexpected argument|unknown field|unknown key') { $eventType = 'cli_argument_or_config_error' }
        elseif ($line -match '(?i)not logged in|authentication|unauthorized') { $eventType = 'cli_authentication_error' }
        elseif ($line -match '(?i)sandbox|permission denied|access is denied') { $eventType = 'sandbox_permission_error' }
        elseif ($line -match '(?i)network|dns|connection refused') { $eventType = 'network_error' }
        try {
          $ev = $line | ConvertFrom-Json -ErrorAction Stop
          if ($ev.type) { $eventType = [string]$ev.type }
        } catch {}
        [ordered]@{ timestamp_utc = [DateTime]::UtcNow.ToString('o'); agent = $Name; attempt = $attempt; turn = $turn; event = $eventType } |
          ConvertTo-Json -Compress | Add-Content -LiteralPath $eventLog -Encoding utf8
      }
      $exitCode = $LASTEXITCODE
      $head = (& git -c "safe.directory=$Workspace" -C $Workspace rev-parse HEAD 2>$null)
      if ($LASTEXITCODE -ne 0) { $head = $null }

      $checkpointData = $null
      $signature = 'missing'
      if (Test-Path -LiteralPath $checkpointPath) {
        try {
          $checkpointData = Get-Content -LiteralPath $checkpointPath -Raw | ConvertFrom-Json
          $signatureData = [ordered]@{
            completed = @($checkpointData.completed)
            current = $checkpointData.current
            milestones = @($checkpointData.milestones)
            tests = @($checkpointData.tests)
            commits = @($checkpointData.commits)
            next = @($checkpointData.next)
            blockers = @($checkpointData.blockers)
            metrics = $checkpointData.metrics
          } | ConvertTo-Json -Depth 10 -Compress
          $sha = [System.Security.Cryptography.SHA256]::Create()
          $signature = [Convert]::ToBase64String($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($signatureData)))
          $sha.Dispose()
        } catch {}
      }

      if ($exitCode -ne 0) {
        $retryCount++
        $status = 'failed'
        if ($retryCount -ge $MaxRetries) { $done = $true }
      } else {
        $status = if ($checkpointData -and $checkpointData.status) { [string]$checkpointData.status } else { 'in_progress' }
        if ($status -in @('completed','complete')) { $status = 'completed'; $done = $true }
        elseif ($status -in @('paused','blocked')) { $done = $true }
        elseif ($signature -eq $lastSignature) { $stalls++; if ($stalls -ge 2) { $status = 'blocked'; $done = $true } }
        else { $stalls = 0 }
      }
      $lastSignature = $signature
      $state.status = $status
      $state.exit_code = $exitCode
      $state.head = $head
      $state.retry_attempts = $retryCount
      $state.turn = $turn
      $state.progress_signature = $lastSignature
      $state.no_progress_turns = $stalls
      $state.updated_at_utc = [DateTime]::UtcNow.ToString('o')
      $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding utf8
      [ordered]@{ timestamp_utc = [DateTime]::UtcNow.ToString('o'); agent = $Name; attempt = $attempt; turn = $turn; event = 'turn_finished'; exit_code = $exitCode; status = $status; head = $head } |
        ConvertTo-Json -Compress | Add-Content -LiteralPath $eventLog -Encoding utf8
      if ($exitCode -ne 0 -and -not $done) { Start-Sleep -Seconds 30 }
    }
    if (-not $done -and $turn -ge $MaxTurns) { $status = 'turn_limit' }
    $state.status = $status
    $state.turn = $turn
    $state.retry_attempts = $retryCount
    $state.updated_at_utc = [DateTime]::UtcNow.ToString('o')
    $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding utf8
    [pscustomobject]@{ agent = $Name; branch = $Branch; exit_code = $exitCode; status = $status; turns = $turn; retries = $retryCount }
  }

  function Get-AgentState($Name) {
    $file = Join-Path $agentsDir ($Name + '.json')
    if (Test-Path -LiteralPath $file) { return (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json) }
    return $null
  }

  function Protect-Text([object]$Value) {
    $text = [string]$Value
    $text = $text -replace '(?i)Bearer\s+[^\s,;]+', 'Bearer [REDACTED]'
    $text = $text -replace 'sb_secret_[A-Za-z0-9_-]+', '[REDACTED]'
    $text = $text -replace 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[REDACTED]'
    $text = $text -replace '(?i)(password|token|secret|authorization)\s*[:=]\s*[^\s,;]+', '$1=[REDACTED]'
    $text = $text -replace '://[^/@\s]+:[^/@\s]+@', '://[REDACTED]@'
    return $text
  }

  function Get-VerifiedEvidence([string]$Workspace, [object]$Evidence) {
    if (-not $Evidence -or [System.IO.Path]::IsPathRooted([string]$Evidence)) { return $null }
    $root = [System.IO.Path]::GetFullPath($Workspace).TrimEnd('\') + '\'
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $Workspace ([string]$Evidence)))
    if (-not $candidate.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $null }
    return Protect-Text $Evidence
  }
  function Start-AgentPhase($Definitions, $PhaseName) {
    $jobs = @()
    foreach ($definition in $Definitions) {
      $workspace = Join-Path $worktreeRoot $definition.Directory
      $existing = Get-AgentState $definition.Name
      if ($ResumeRunId -and $existing -and $existing.status -in @('completed','failed','blocked','paused','turn_limit')) { continue }
      if (-not (Test-Path -LiteralPath $workspace -PathType Container)) {
        [ordered]@{ agent = $definition.Name; status = 'blocked'; reason = 'worktree_missing'; timestamp_utc = [DateTime]::UtcNow.ToString('o') } |
          ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $agentsDir ($definition.Name + '.json')) -Encoding utf8
        continue
      }
      $actualBranch = (& git -c "safe.directory=$workspace" -C $workspace branch --show-current).Trim()
      if ($LASTEXITCODE -ne 0 -or $actualBranch -ne $definition.Branch) { throw "Branch validation failed for $($definition.Name)." }
      $taskFile = 'docs/tasks/' + $definition.Name + '.md'
      $jobs += Start-Job -Name $definition.Name -ArgumentList @(
        $definition.Name,$definition.Branch,$workspace,$taskFile,$codexPath,$gitCommon,$runDir,$storageStatePath,2,24
      ) -ScriptBlock $agentJob
    }
    while (@($jobs | Where-Object { $_.State -eq 'Running' }).Count -gt 0) {
      Wait-Job -Job $jobs -Any -Timeout 30 | Out-Null
    }
    $results = @()
    foreach ($job in $jobs) { $results += Receive-Job -Job $job; Remove-Job -Job $job }
    [ordered]@{ phase = $PhaseName; completed_at_utc = [DateTime]::UtcNow.ToString('o'); results = $results }
  }

  $featureDefinitions = @(
    @{ Name='tourism-data'; Branch='dev/tourism-data'; Directory='tourism-data' },
    @{ Name='itinerary'; Branch='dev/itinerary'; Directory='itinerary' },
    @{ Name='backend'; Branch='dev/backend'; Directory='backend' },
    @{ Name='frontend'; Branch='dev/frontend'; Directory='frontend' },
    @{ Name='qa'; Branch='dev/qa'; Directory='qa' }
  )
  $integrationDefinition = @(@{ Name='integration'; Branch='dev/integration'; Directory='integration' })

  $featurePhase = Start-AgentPhase $featureDefinitions 'feature-agents-parallel'
  $featurePhase | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $runDir 'feature-phase.json') -Encoding utf8
  $integrationPhase = Start-AgentPhase $integrationDefinition 'integration-coordinator'
  $integrationPhase | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $runDir 'integration-phase.json') -Encoding utf8

  New-Item -ItemType File -Force -Path $stopStoragePath | Out-Null
  Stop-Job $watcher -ErrorAction SilentlyContinue
  Receive-Job $watcher -ErrorAction SilentlyContinue | Out-Null
  Remove-Job $watcher -ErrorAction SilentlyContinue

  $finalDisk = Get-CDriveState
  $summaryAgents = @()
  foreach ($definition in (@($featureDefinitions) + @($integrationDefinition))) {
    $state = Get-AgentState $definition.Name
    $workspace = Join-Path $worktreeRoot $definition.Directory
    $head = $null
    if (Test-Path -LiteralPath $workspace) { $head = (& git -c "safe.directory=$workspace" -C $workspace rev-parse HEAD 2>$null); if ($LASTEXITCODE -ne 0) { $head = $null } }
    $checkpointSummary = $null
    if ($state -and $state.checkpoint -and (Test-Path -LiteralPath $state.checkpoint)) {
      try {
        $p = Get-Content -LiteralPath $state.checkpoint -Raw | ConvertFrom-Json
        $milestones = @()
        foreach ($milestone in @($p.milestones)) {
          $evidence = Get-VerifiedEvidence $workspace $milestone.evidence
          if ($milestone.status -eq 'completed' -and $evidence) {
            $milestones += [ordered]@{ name = Protect-Text $milestone.name; status = 'completed'; evidence = $evidence }
          }
        }
        $tests = @()
        foreach ($test in @($p.tests)) {
          $evidence = Get-VerifiedEvidence $workspace $test.evidence
          if ($test) { $tests += [ordered]@{ name = Protect-Text $test.name; result = Protect-Text $test.result; evidence = $evidence } }
        }
        $metricValues = [ordered]@{}
        foreach ($metricName in @('attractions_collected','hotels_collected','restaurants_collected','cities_completed','itineraries_generated','itineraries_validated')) {
          $metric = $p.metrics.$metricName
          $evidence = if ($metric) { Get-VerifiedEvidence $workspace $metric.evidence } else { $null }
          $metricNumber = 0.0
          $validNumber = $metric -and [double]::TryParse([string]$metric.value,[ref]$metricNumber)
          if ($metric -and $metric.verified -eq $true -and $metric.mock -ne $true -and $evidence -and $validNumber -and $metricNumber -ge 0) {
            $metricValues[$metricName] = [ordered]@{ value = $metricNumber; evidence = $evidence }
          }
        }
        $checkpointSummary = [ordered]@{
          status = Protect-Text $p.status
          completed = @($p.completed | ForEach-Object { Protect-Text $_ })
          current = Protect-Text $p.current
          milestones = $milestones
          tests = $tests
          commits = @($p.commits | Where-Object { [string]$_ -match '^[0-9a-fA-F]{7,40}$' })
          next = @($p.next | ForEach-Object { Protect-Text $_ })
          blockers = @($p.blockers | ForEach-Object { Protect-Text $_ })
          errors = @($p.errors | ForEach-Object { Protect-Text $_ })
          metrics = $metricValues
          updated_at_utc = Protect-Text $p.updated_at_utc
        }
      } catch { $checkpointSummary = [ordered]@{ status = 'invalid_checkpoint_json' } }
    }    $reported = if ($state) { [string]$state.status } else { 'not_started' }
    if ($checkpointSummary -and $checkpointSummary.status -in @('paused','blocked','in_progress')) { $reported = [string]$checkpointSummary.status }
    $summaryAgents += [ordered]@{
      agent = $definition.Name
      branch = $definition.Branch
      status = $reported
      process_id = if ($state) { $state.process_id } else { $null }
      turns = if ($state) { $state.turn } else { 0 }
      retries = if ($state) { $state.retry_attempts } else { 0 }
      head = $head
      checkpoint = if ($state) { $state.checkpoint } else { $null }
      progress = $checkpointSummary
    }
  }
  $summary = [ordered]@{
    run_id = $runId
    started_at_utc = $runStarted
    finished_at_utc = [DateTime]::UtcNow.ToString('o')
    status = if (@($summaryAgents | Where-Object { $_.status -ne 'completed' }).Count -eq 0) { 'completed' } else { 'incomplete' }
    storage = [ordered]@{ initial = $initialDisk; final = $finalDisk; state_file = $storageStatePath; log = $storageLog }
    dashboard_url = $dashboardUrl
    dashboard_pid = $dashboardPid
    agents = $summaryAgents
    logs_directory = $logsDir
    note = 'Agent JSONL logs store timestamps and event types only. Progress metrics require an existing evidence file; mocks are excluded.'
  }
  $summaryPath = Join-Path $runDir 'morning-summary.json'
  $summary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $summaryPath -Encoding utf8
  [ordered]@{ run_id = $runId; status = $summary.status; summary = $summaryPath; started_at_utc = $runStarted; finished_at_utc = $summary.finished_at_utc; dashboard_url = $dashboardUrl; dashboard_pid = $dashboardPid } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statusPath -Encoding utf8
  $summary | ConvertTo-Json -Depth 12
}
finally {
  if ($watcher -and $watcher.State -eq 'Running') {
    New-Item -ItemType File -Force -Path $stopStoragePath | Out-Null
    Stop-Job $watcher -ErrorAction SilentlyContinue
    Remove-Job $watcher -ErrorAction SilentlyContinue
  }
  if ($mutex) { try { $mutex.ReleaseMutex() } catch {}; $mutex.Dispose() }
}
