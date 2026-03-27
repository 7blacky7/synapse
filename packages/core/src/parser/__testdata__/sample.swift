import Foundation
import Combine

let maxRetries = 3
let defaultModel = "claude-opus-4-6"

enum Status: String, Codable {
    case active, idle, stopped, error
}

struct AgentConfig: Codable {
    var model: String = defaultModel
    var maxTokens: Int = 4096
    var temperature: Double = 0.7
}

protocol Agent: AnyObject {
    var name: String { get }
    var status: Status { get }
    func process(_ message: String) async throws -> String
    func getTools() -> [String]
}

protocol Configurable {
    func configure(_ config: AgentConfig)
}

class BaseAgent: Agent {
    let name: String
    private(set) var status: Status = .idle
    var config: AgentConfig

    init(name: String, config: AgentConfig = AgentConfig()) {
        self.name = name
        self.config = config
    }

    func process(_ message: String) async throws -> String {
        fatalError("Must override")
    }

    func getTools() -> [String] { [] }

    func validate(_ input: String) -> Bool {
        !input.trimmingCharacters(in: .whitespaces).isEmpty
    }
}

class SynapseAgent: BaseAgent, Configurable {
    private let queue = DispatchQueue(label: "synapse.agent")

    override func process(_ message: String) async throws -> String {
        guard validate(message) else {
            throw AgentError.invalidInput("Empty message")
        }
        status = .active
        defer { status = .idle }
        return await callModel(message)
    }

    override func getTools() -> [String] {
        ["search", "read", "write"]
    }

    func configure(_ config: AgentConfig) {
        self.config = config
    }

    private func callModel(_ message: String) async -> String {
        // TODO: implement actual API call
        "Response to: \(message)"
    }

    static func create(name: String) -> SynapseAgent {
        SynapseAgent(name: name)
    }
}

enum AgentError: Error, LocalizedError {
    case invalidInput(String)
    case timeout
    case modelError(String)

    var errorDescription: String? {
        switch self {
        case .invalidInput(let msg): return "Invalid input: \(msg)"
        case .timeout: return "Request timed out"
        case .modelError(let msg): return "Model error: \(msg)"
        }
    }
}

extension SynapseAgent: CustomStringConvertible {
    var description: String { "\(name) [\(status.rawValue)]" }
}

// FIXME: race condition on status property
