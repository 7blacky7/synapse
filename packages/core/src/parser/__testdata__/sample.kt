package com.synapse.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap

const val MAX_RETRIES = 3
const val DEFAULT_MODEL = "claude-opus-4-6"

enum class Status { ACTIVE, IDLE, STOPPED, ERROR }

data class AgentConfig(
    val model: String = DEFAULT_MODEL,
    val maxTokens: Int = 4096,
    val temperature: Double = 0.7,
)

sealed class AgentResult {
    data class Success(val message: String) : AgentResult()
    data class Error(val code: Int, val message: String) : AgentResult()
}

interface Agent {
    suspend fun process(message: String): AgentResult
    fun getTools(): List<String>
    val status: Status
}

interface Configurable {
    fun configure(config: AgentConfig)
}

abstract class BaseAgent(val name: String) : Agent {
    protected var _status: Status = Status.IDLE
    override val status get() = _status

    protected fun validate(input: String): Boolean = input.isNotBlank()
}

class SynapseAgent(
    name: String,
    private var config: AgentConfig = AgentConfig(),
) : BaseAgent(name), Configurable {

    override suspend fun process(message: String): AgentResult =
        withContext(Dispatchers.IO) {
            _status = Status.ACTIVE
            val result = callModel(message)
            _status = Status.IDLE
            AgentResult.Success(result)
        }

    override fun getTools(): List<String> = listOf("search", "read", "write")

    override fun configure(config: AgentConfig) {
        this.config = config
    }

    private suspend fun callModel(message: String): String {
        // TODO: implement actual API call
        return "Response to: $message"
    }

    companion object {
        fun create(name: String) = SynapseAgent(name)
    }
}

object AgentRegistry {
    private val agents = ConcurrentHashMap<String, Agent>()

    fun register(agent: SynapseAgent) { agents[agent.name] = agent }
    fun get(name: String): Agent? = agents[name]
    fun listAll(): List<Agent> = agents.values.toList()
}

fun createAgent(name: String, config: AgentConfig? = null): SynapseAgent =
    SynapseAgent(name, config ?: AgentConfig())

// FIXME: add proper error handling in process
