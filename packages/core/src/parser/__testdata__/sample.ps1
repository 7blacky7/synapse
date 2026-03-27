#Requires -Version 7.0
using namespace System.Collections.Generic

Import-Module Az.Accounts
. .\utils.ps1

$MaxRetries = 3
$DefaultModel = 'claude-opus-4-6'
$script:AgentCount = 0

enum Status {
    Active
    Idle
    Stopped
    Error
}

class AgentConfig {
    [string]$Model = 'claude-opus-4-6'
    [int]$MaxTokens = 4096
    [double]$Temperature = 0.7

    AgentConfig() {}
    AgentConfig([string]$model) { $this.Model = $model }
}

class Agent {
    [string]$Name
    [AgentConfig]$Config
    [Status]$Status = [Status]::Idle
    hidden [List[string]]$_tools = @('search', 'read', 'write')

    Agent([string]$name) {
        $this.Name = $name
        $this.Config = [AgentConfig]::new()
    }

    Agent([string]$name, [AgentConfig]$config) {
        $this.Name = $name
        $this.Config = $config
    }

    [string] Process([string]$message) {
        if ([string]::IsNullOrWhiteSpace($message)) {
            throw "Empty message"
        }
        $this.Status = [Status]::Active
        $result = $this.CallModel($message)
        $this.Status = [Status]::Idle
        return $result
    }

    [List[string]] GetTools() { return $this._tools }

    hidden [string] CallModel([string]$message) {
        # TODO: implement actual API call
        return "Response to: $message"
    }
}

function New-Agent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [AgentConfig]$Config
    )

    if ($null -eq $Config) { $Config = [AgentConfig]::new() }
    $agent = [Agent]::new($Name, $Config)
    $script:AgentCount++
    return $agent
}

function Get-AgentStatus {
    param([Agent]$Agent)
    return $Agent.Status
}

function Invoke-AgentProcess {
    param(
        [Agent]$Agent,
        [string]$Message
    )
    return $Agent.Process($Message)
}

# FIXME: add error handling for API calls
