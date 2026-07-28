using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Synapse.Core
{
    public enum Status { Active, Idle, Stopped, Error }

    public record AgentConfig(string Model = "claude-opus-4-6", int MaxTokens = 4096, double Temperature = 0.7);

    public interface IAgent
    {
        Task<string> ProcessAsync(string message);
        IReadOnlyList<string> GetTools();
        Status Status { get; }
    }

    public interface IConfigurable
    {
        void Configure(AgentConfig config);
    }

    public struct Point
    {
        public double X { get; init; }
        public double Y { get; init; }
    }

    public abstract class BaseAgent : IAgent
    {
        protected readonly ILogger _logger;
        public const int MaxRetries = 3;

        protected BaseAgent(ILogger logger)
        {
            _logger = logger;
        }

        public abstract Task<string> ProcessAsync(string message);
        public abstract IReadOnlyList<string> GetTools();
        public Status Status { get; protected set; } = Status.Idle;
    }

    public class SynapseAgent : BaseAgent, IConfigurable
    {
        public string Name { get; }
        private AgentConfig _config;

        public SynapseAgent(string name, AgentConfig config, ILogger<SynapseAgent> logger)
            : base(logger)
        {
            Name = name;
            _config = config;
        }

        public override async Task<string> ProcessAsync(string message)
        {
            Status = Status.Active;
            _logger.LogInformation("Processing: {Message}", message);
            await Task.Delay(10);
            Status = Status.Idle;
            return $"Response to: {message}";
        }

        public override IReadOnlyList<string> GetTools()
            => new[] { "search", "read", "write" };

        public void Configure(AgentConfig config)
        {
            _config = config;
        }

        private bool Validate(string input) => !string.IsNullOrWhiteSpace(input);

        public static SynapseAgent Create(string name)
            => new(name, new AgentConfig(), null!);
    }

    // Verschachtelung fuer den findParentType-Fall: Entry steht DIREKT am Anfang
    // von Registry, ohne schliessende Klammer dazwischen. Bis Parser-Version 3
    // lieferte der Eltern-Typ hier die AEUSSERE Deklaration (Registry) statt Entry.
    // Describe/DescribeTwice und Lookup/Count decken zusaetzlich den haeufigeren
    // Fall ab: ab der ZWEITEN Methode ging der Eltern-Typ ganz verloren.
    public class Registry
    {
        public class Entry
        {
            public string Key;

            public string Describe() => Key;

            public string DescribeTwice() => Key + Key;
        }

        public Entry Lookup(string key) => null!;

        public int Count() => 0;
    }

    public delegate void StatusChanged(Status oldStatus, Status newStatus);

    // TODO: add health check endpoint
    // FIXME: logger null reference in Create method
}
