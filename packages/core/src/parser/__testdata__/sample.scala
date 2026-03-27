package com.synapse.core

import scala.concurrent.{Future, ExecutionContext}
import scala.util.{Try, Success, Failure}

object Constants {
  val MaxRetries: Int = 3
  val DefaultModel: String = "claude-opus-4-6"
}

sealed trait Status
case object Active extends Status
case object Idle extends Status
case object Stopped extends Status
case class Error(message: String) extends Status

case class AgentConfig(
  model: String = Constants.DefaultModel,
  maxTokens: Int = 4096,
  temperature: Double = 0.7
)

trait Agent {
  def process(message: String)(implicit ec: ExecutionContext): Future[String]
  def getTools: List[String]
  def status: Status
}

trait Configurable {
  def configure(config: AgentConfig): Unit
}

abstract class BaseAgent(val name: String) extends Agent {
  protected var _status: Status = Idle
  override def status: Status = _status

  protected def validate(input: String): Boolean =
    input != null && input.trim.nonEmpty
}

class SynapseAgent(
  name: String,
  private var config: AgentConfig = AgentConfig()
) extends BaseAgent(name) with Configurable {

  override def process(message: String)(implicit ec: ExecutionContext): Future[String] = {
    _status = Active
    Future {
      val result = callModel(message)
      _status = Idle
      result
    }
  }

  override def getTools: List[String] = List("search", "read", "write")

  override def configure(config: AgentConfig): Unit = {
    this.config = config
  }

  private def callModel(message: String): String = {
    // TODO: implement actual model call
    s"Response to: $message"
  }
}

object SynapseAgent {
  def apply(name: String): SynapseAgent = new SynapseAgent(name)
}

// FIXME: add proper error handling
