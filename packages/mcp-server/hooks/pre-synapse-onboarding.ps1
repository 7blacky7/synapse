# Synapse Agent Onboarding Hook
# Handles: PreToolUse:Read (Hauptagent) + SubagentStart (Subagenten)
# PreToolUse → additionalContext (einmal pro Session)
# SubagentStart → updatedPrompt (jeder Subagent)

param()

$inputJson = $input | Out-String
if (-not $inputJson -or $inputJson.Trim().Length -eq 0) { exit 0 }

try {
    $hookInput = $inputJson | ConvertFrom-Json
} catch {
    exit 0
}

$hookEvent = $hookInput.hook_event_name

# ============================================
# Dateipfad / Projektverzeichnis ermitteln
# ============================================
$startPath = $null

if ($hookEvent -eq "SubagentStart") {
    # SubagentStart: CLAUDE_PROJECT_DIR oder cwd
    $startPath = $hookInput.cwd
    if (-not $startPath) { $startPath = $env:CLAUDE_PROJECT_DIR }
    if (-not $startPath) { $startPath = (Get-Location).Path }
} else {
    # PreToolUse: file_path aus tool_input
    $toolInput = $hookInput.tool_input
    if (-not $toolInput) { exit 0 }
    if ($toolInput.file_path) { $startPath = $toolInput.file_path }
    elseif ($toolInput.path) { $startPath = $toolInput.path }
}

if (-not $startPath) { exit 0 }

# ============================================
# Projekt-Root mit .synapse/status.json finden
# ============================================
function Find-SynapseProject {
    param($path)
    if (Test-Path $path -PathType Leaf) {
        $dir = Split-Path $path -Parent
    } else {
        $dir = $path
    }
    while ($dir) {
        $statusFile = Join-Path $dir ".synapse\status.json"
        if (Test-Path $statusFile) {
            return @{ Path = $dir; StatusFile = $statusFile }
        }
        $parent = Split-Path $dir -Parent
        if ($parent -eq $dir -or -not $parent) { break }
        $dir = $parent
    }
    return $null
}

$project = Find-SynapseProject -path $startPath
if (-not $project) { exit 0 }

try {
    $status = Get-Content $project.StatusFile -Raw | ConvertFrom-Json
} catch {
    exit 0
}

$projectName = $status.project
if (-not $projectName) { exit 0 }

# ============================================
# Session-Tracking (NUR fuer PreToolUse, NICHT fuer Subagenten)
# ============================================
if ($hookEvent -ne "SubagentStart") {
    $sessionMarker = Join-Path $env:TEMP "synapse-onboarding-$projectName.marker"
    if (Test-Path $sessionMarker) {
        $markerAge = (Get-Date) - (Get-Item $sessionMarker).LastWriteTime
        if ($markerAge.TotalMinutes -lt 30) {
            exit 0
        }
    }
    New-Item $sessionMarker -Force | Out-Null
}

# ============================================
# Bekannte Agenten
# ============================================
$knownAgents = @()
if ($status.knownAgents) { $knownAgents = $status.knownAgents }

# ============================================
# Letzte Thoughts aus Qdrant
# ============================================
function Get-RecentThoughts {
    param($proj, $limit = 5)
    $body = @{
        limit = $limit
        filter = @{ must = @(@{ key = "project"; match = @{ value = $proj } }) }
        with_payload = $true
    } | ConvertTo-Json -Depth 5
    try {
        $r = Invoke-RestMethod -Uri "http://192.168.50.65:6334/collections/project_thoughts/points/scroll" `
            -Method POST -Body $body -ContentType "application/json" -TimeoutSec 3
        return $r.result.points
    } catch {
        return @()
    }
}

$thoughts = Get-RecentThoughts -proj $projectName -limit 5

# ============================================
# Onboarding-Message generieren
# ============================================
$msg = "Dieses Projekt nutzt Synapse MCP fuer Agent-Koordination.`n"
$msg += "Projekt: $projectName | Status: $($status.status)`n"

if ($knownAgents.Count -gt 0) {
    $msg += "Aktive Agenten: $($knownAgents -join ', ')`n"
}

if ($thoughts.Count -gt 0) {
    $msg += "Letzte Erkenntnisse im Projekt:`n"
    foreach ($t in $thoughts) {
        $p = $t.payload
        $src = if ($p.source) { $p.source } else { "?" }
        $cnt = if ($p.content) { if ($p.content.Length -gt 80) { $p.content.Substring(0,80) + "..." } else { $p.content } } else { "" }
        $tgs = if ($p.tags) { $p.tags -join "," } else { "" }
        $msg += "  $src - $cnt ($tgs)`n"
    }
}

$msg += "Synapse-Tools: mcp__synapse__read_memory (project:`"$projectName`" name:`"projekt-regeln`" agent_id:`"dein-name`"), mcp__synapse__search_thoughts, mcp__synapse__add_thought"

# ============================================
# Output je nach Event-Typ
# ============================================
if ($hookEvent -eq "SubagentStart") {
    # SubagentStart: updatedPrompt = Original-Prompt + Onboarding
    $originalPrompt = $hookInput.subagent_prompt
    if (-not $originalPrompt) { $originalPrompt = "" }

    $updatedPrompt = @"
$msg

--- ORIGINAL TASK ---

$originalPrompt
"@

    $output = @{
        updatedPrompt = $updatedPrompt
    } | ConvertTo-Json -Depth 3 -Compress
} else {
    # PreToolUse: additionalContext
    $output = @{
        hookSpecificOutput = @{
            hookEventName = "PreToolUse"
            additionalContext = $msg
        }
    } | ConvertTo-Json -Depth 3 -Compress
}

Write-Output $output
exit 0
