// SOLLWERTE fuer packages/core/tests/fixture-zeilennummern.test.mjs.
// Eckige Klammern, KEINE Anfuehrungszeichen (siehe Runner-Kopf).
// Abgedeckt: der ScopeProbe-Fall (Kontrollfluss-Block, gefolgt von einem
// Statement in derselben Methode) und der Verschachtelungsfall Registry/Entry.
//   [ScopeProbe] -> Zeile 101
//   [mitVerzweigung] -> Zeile 102
//   [mitSchleife] -> Zeile 108
//   [mitAbsicherung] -> Zeile 115
//   [Registry] -> Zeile 123
//   [Entry] -> Zeile 125
//   [describe] -> Zeile 127
//   [lookup] -> Zeile 132

package com.synapse.core

import groovy.transform.CompileStatic
import groovy.transform.ToString

@CompileStatic
class AgentConfig {
    String model = 'claude-opus-4-6'
    int maxTokens = 4096
    double temperature = 0.7
}

enum Status {
    ACTIVE, IDLE, STOPPED, ERROR
}

interface Agent {
    String process(String message)
    List<String> getTools()
    Status getStatus()
}

trait HasLogging {
    void log(String message) {
        println "[${this.class.simpleName}] $message"
    }
}

@ToString(includeNames = true)
abstract class BaseAgent implements Agent, HasLogging {
    final String name
    AgentConfig config
    protected Status status = Status.IDLE

    BaseAgent(String name, AgentConfig config = null) {
        this.name = name
        this.config = config ?: new AgentConfig()
    }

    protected boolean validate(String input) {
        input?.trim()
    }
}

class SynapseAgent extends BaseAgent {
    SynapseAgent(String name, AgentConfig config = null) {
        super(name, config)
    }

    @Override
    String process(String message) {
        assert validate(message): 'Empty message'
        status = Status.ACTIVE
        def result = callModel(message)
        status = Status.IDLE
        result
    }

    @Override
    List<String> getTools() {
        ['search', 'read', 'write']
    }

    @Override
    Status getStatus() { status }

    private String callModel(String message) {
        // TODO: implement actual model call
        "Response to: $message"
    }
}

static SynapseAgent createAgent(String name) {
    new SynapseAgent(name)
}

// Verschachtelung fuer den findParentType-Fall: Entry steht DIREKT am Anfang von
// Registry, ohne schliessende Klammer dazwischen. Bis Parser-Version 3 lieferte der
// Eltern-Typ hier die AEUSSERE Deklaration (Registry) statt Entry. describe und
// describeTwice sowie lookup und count decken zusaetzlich den haeufigeren Fall ab:
// ab der ZWEITEN Methode einer Klasse ging der Eltern-Typ ganz verloren.
// Probe fuer die scopeIdx-Zuordnung (korrigiert in Parser-Version 4).
// WORAUF ES ANKOMMT: ein Block, der KEINEN eigenen Scope anlegt (if, while, for,
// switch, try, Gradle-DSL), gefolgt von einem weiteren Statement in derselben
// Methode. Bis Version 3 schnitt der schliessende Block den vorgefundenen Scope ab:
// nachDemBlock() wurde der KLASSE zugeordnet statt der Methode. Der Absturz bei
// scopeIdx 0 war derselbe Fehler eine Ebene tiefer.
class ScopeProbe {
    void mitVerzweigung(int wert) {
        if (wert > 0) {
            imBlock()
        }
        nachDemBlock()
    }

    void mitSchleife(List eintraege) {
        for (e in eintraege) {
            imBlock()
        }
        nachDemBlock()
    }

    void mitAbsicherung() {
        try {
            imBlock()
        }
        nachDemBlock()
    }
}

class Registry {
    class Entry {
        String key

        String describe() { key }

        String describeTwice() { key + key }
    }

    Entry lookup(String key) { null }

    int count() { 0 }
}

def MAX_RETRIES = 3

// FIXME: add proper error handling
