#!/usr/bin/env tclsh

package require Tcl 8.6
package require json
package require http

namespace eval ::synapse {
    variable MAX_RETRIES 3
    variable DEFAULT_MODEL "claude-opus-4-6"
    variable agent_count 0

    namespace export create_agent process get_tools
}

proc ::synapse::create_agent {name {config {}}} {
    variable DEFAULT_MODEL
    variable agent_count

    if {$config eq {}} {
        set config [dict create \
            model $DEFAULT_MODEL \
            max_tokens 4096 \
            temperature 0.7]
    }

    set agent [dict create \
        name $name \
        config $config \
        status idle \
        tools {search read write}]

    incr agent_count
    return $agent
}

proc ::synapse::process {agentVar message} {
    upvar 1 $agentVar agent

    if {[string trim $message] eq ""} {
        error "Empty message"
    }

    dict set agent status active
    set result [call_model $message [dict get $agent config]]
    dict set agent status idle
    return $result
}

proc ::synapse::call_model {message config} {
    # TODO: implement actual API call
    return "Response to: $message"
}

proc ::synapse::get_tools {agent} {
    return [dict get $agent tools]
}

proc ::synapse::get_status {agent} {
    return [dict get $agent status]
}

proc ::synapse::validate {input} {
    return [expr {[string trim $input] ne ""}]
}

# FIXME: add proper error handling
