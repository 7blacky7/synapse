# Synapse Onboarding Hook (Windows-Fassung von pre-synapse-onboarding.sh)
# PreToolUse:Read -> Koordinator-Regeln (additionalContext, einmal je Projekt)
# SubagentStart   -> Agent-Regeln mit automatischer ID (updatedPrompt)
#
# Inhaltlich deckungsgleich mit pre-synapse-onboarding.sh: Schritt 1 ist
# admin(index_stats) - fuer Subagenten mit sitzung "neu" (Spawn-Signal, f3b56df/d6a13e5).
# Wer die .sh aendert, aendert diese Datei mit. Nur ASCII, damit Windows PowerShell 5.1
# die Datei ohne BOM richtig liest.

param()

$ErrorActionPreference = 'Stop'

$inputJson = $input | Out-String
if (-not $inputJson -or $inputJson.Trim().Length -eq 0) { exit 0 }

try {
    $hookInput = $inputJson | ConvertFrom-Json
} catch {
    exit 0
}

$hookEvent = $hookInput.hook_event_name
if (-not $hookEvent) { exit 0 }

# ============================================
# Projektverzeichnis ermitteln
# ============================================
$startPath = $null
if ($hookEvent -eq 'SubagentStart') {
    $startPath = $hookInput.cwd
    if (-not $startPath) { $startPath = $env:CLAUDE_PROJECT_DIR }
    if (-not $startPath) { $startPath = (Get-Location).Path }
} else {
    $toolInput = $hookInput.tool_input
    if ($toolInput) {
        if ($toolInput.file_path) { $startPath = $toolInput.file_path }
        elseif ($toolInput.path) { $startPath = $toolInput.path }
    }
}
if (-not $startPath) { exit 0 }

# ============================================
# Projekt-Root finden
# ============================================
function Find-SynapseProject {
    param($path)
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        $dir = Split-Path $path -Parent
    } else {
        $dir = $path
    }
    while ($dir) {
        $statusFile = Join-Path (Join-Path $dir '.synapse') 'status.json'
        if (Test-Path -LiteralPath $statusFile -PathType Leaf) {
            return @{ Path = $dir; StatusFile = $statusFile }
        }
        $parent = Split-Path $dir -Parent
        if (-not $parent -or $parent -eq $dir) { break }
        $dir = $parent
    }
    return $null
}

$project = Find-SynapseProject -path $startPath
if (-not $project) { exit 0 }

try {
    $status = Get-Content -LiteralPath $project.StatusFile -Raw | ConvertFrom-Json
} catch {
    exit 0
}

$projectName = $status.project
if (-not $projectName) { exit 0 }
$projectStatus = if ($status.status) { $status.status } else { 'unknown' }

$nl = "`n"
$q = '"'

# ============================================
# KOORDINATOR (PreToolUse:Read)
# ============================================
if ($hookEvent -ne 'SubagentStart') {
    # Einmal pro Session: nach dem ersten Anzeigen nicht wiederholen
    $tempDir = if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
    $marker = Join-Path $tempDir "synapse-onboarded-$projectName-koordinator.marker"
    if (Test-Path -LiteralPath $marker) { exit 0 }

    $msg  = "Synapse MCP aktiv | Projekt: $projectName | Status: $projectStatus$nl"
    $msg += "Du bist der KOORDINATOR.$nl"
    $msg += "Session-Start (PFLICHT - einmal zu Beginn):$nl"
    $msg += "1. admin(action: ${q}index_stats$q, project: $q$projectName$q, agent_id: ${q}koordinator$q, role: ${q}koordinator$q)$nl"
    $msg += "2. chat(action: ${q}register$q, id: ${q}koordinator$q, project: $q$projectName$q, model: ${q}claude-opus-4-6$q)$nl"
    $msg += "3. chat(action: ${q}get$q, project: $q$projectName$q, agent_id: ${q}koordinator$q, limit: 10)$nl"
    $msg += "Agenten spawnen: Prompt-Baustein aus synapse-nutzung Skill einbetten$nl"
    $msg += "Spezialisten mit role: ${q}spezialist$q, Subagenten mit role: ${q}subagent$q anmelden."

    New-Item -ItemType File -Path $marker -Force | Out-Null

    $output = @{
        hookSpecificOutput = @{
            hookEventName     = 'PreToolUse'
            additionalContext = $msg
        }
    } | ConvertTo-Json -Depth 3 -Compress

# ============================================
# AGENT (SubagentStart)
# ============================================
} else {
    $agentId = $hookInput.agent_id
    if (-not $agentId) { $agentId = 'agent-' + ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() % 100000) }

    $msg  = "=== SYNAPSE AGENT-ONBOARDING ===$nl"
    $msg += "Projekt: $projectName | Deine ID: $agentId | Rolle: subagent$nl$nl"
    $msg += "PFLICHT-SCHRITTE (ALLERERSTE Aktionen):$nl"
    $msg += "1. admin(action: ${q}index_stats$q, project: $q$projectName$q, agent_id: $q$agentId$q, role: ${q}subagent$q, sitzung: ${q}neu$q)$nl"
    $msg += "   -> Du bekommst Projekt-Regeln. Befolge sie.$nl"
    $msg += "   -> sitzung: ${q}neu$q weil du frisch gespawnt bist (auch wenn dein Auftrag einen schon benutzten Namen vorgibt).$nl"
    $msg += "2. chat(action: ${q}get$q, project: $q$projectName$q, agent_id: $q$agentId$q, limit: 10)$nl$nl"
    $msg += "SUCHE: IMMER zuerst code_intel, dann search(action: ${q}code$q). Glob/Grep nur Fallback. Binaer-/Asset-Dateien (Bilder, 3D, Audio, Archive, Executables, Unreal, DCC): asset_intel.$nl"
    $msg += "CHAT: channel(action: ${q}post$q) fuer Status. DM: chat(action: ${q}send$q, recipient_id: ${q}koordinator$q) bei Problemen.$nl"
    $msg += "ENDE: chat(action: ${q}unregister$q, id: $q$agentId$q)$nl"
    $msg += "agent_id: $q$agentId$q an JEDEN Synapse-Aufruf. source: $q$agentId$q bei thought(action: ${q}add$q).$nl"
    $msg += "=== ENDE AGENT-ONBOARDING ===$nl"

    $originalPrompt = $hookInput.subagent_prompt
    if (-not $originalPrompt) { $originalPrompt = '' }
    $updatedPrompt = $msg + "$nl$nl--- ORIGINAL TASK ---$nl$nl" + $originalPrompt

    $output = @{ updatedPrompt = $updatedPrompt } | ConvertTo-Json -Depth 3 -Compress
}

Write-Output $output
exit 0
