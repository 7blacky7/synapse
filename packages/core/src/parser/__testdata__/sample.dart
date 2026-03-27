import 'dart:async';
import 'dart:convert';
import 'package:meta/meta.dart';

const int maxRetries = 3;
const String defaultModel = 'claude-opus-4-6';

enum Status { active, idle, stopped, error }

class AgentConfig {
  final String model;
  final int maxTokens;
  final double temperature;

  const AgentConfig({
    this.model = defaultModel,
    this.maxTokens = 4096,
    this.temperature = 0.7,
  });

  factory AgentConfig.fromJson(Map<String, dynamic> json) {
    return AgentConfig(
      model: json['model'] as String? ?? defaultModel,
      maxTokens: json['max_tokens'] as int? ?? 4096,
    );
  }
}

abstract class Agent {
  String get name;
  Status get status;
  Future<String> process(String message);
  List<String> getTools();
}

mixin HasLogging {
  void log(String message) => print('[Agent] $message');
}

abstract class BaseAgent extends Agent with HasLogging {
  @override
  final String name;
  AgentConfig config;
  Status _status = Status.idle;

  BaseAgent(this.name, {AgentConfig? config})
      : config = config ?? const AgentConfig();

  @override
  Status get status => _status;

  @protected
  bool validate(String input) => input.trim().isNotEmpty;
}

class SynapseAgent extends BaseAgent {
  SynapseAgent(super.name, {super.config});

  @override
  Future<String> process(String message) async {
    if (!validate(message)) throw ArgumentError('Empty message');
    _status = Status.active;
    final result = await _callModel(message);
    _status = Status.idle;
    return result;
  }

  @override
  List<String> getTools() => ['search', 'read', 'write'];

  Future<String> _callModel(String message) async {
    // TODO: implement actual API call
    return 'Response to: $message';
  }

  factory SynapseAgent.create(String name) => SynapseAgent(name);
}

extension AgentExtensions on Agent {
  bool get isActive => status == Status.active;
  bool get isIdle => status == Status.idle;
}

// FIXME: add proper error handling
