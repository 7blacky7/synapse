// P16-T21: explicit Roslyn compilation only. Never MSBuild, analyzers, generators or Emit.
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

class Pruefer {
    static int Main(string[] args) {
        var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
        var diagnostics = new List<object>();
        var gaps = new List<string>();
        var refRoot = input.GetProperty("referenceRoot").GetString()!;
        var dirs = Directory.GetDirectories(refRoot).OrderByDescending(x => Version.Parse(Path.GetFileName(x))).ToArray();
        if (dirs.Length == 0) throw new Exception("Referenzassemblies fehlen");
        var framework = Directory.GetFiles(Path.Combine(dirs[0], "ref", "net10.0"), "*.dll")
            .Select(x => MetadataReference.CreateFromFile(x)).Cast<MetadataReference>().ToArray();
        var definitions = input.GetProperty("projects").EnumerateArray().ToDictionary(p => p.GetProperty("id").GetString()!);
        var compiled = new Dictionary<string, CSharpCompilation>();
        var visiting = new HashSet<string>();
        CSharpCompilation Compile(string id) {
            if (compiled.TryGetValue(id, out var old)) return old;
            if (!visiting.Add(id)) throw new Exception("Zyklische Projektverweise");
            var p = definitions[id];
            var langText = p.GetProperty("language").GetString()!;
            if (!LanguageVersionFacts.TryParse(langText, out var lang)) {
                gaps.Add("Nicht unterstuetzter LangVersion-Wert"); lang = LanguageVersion.Default;
            }
            var symbols = p.GetProperty("defines").EnumerateArray().Select(x => x.GetString()!).ToArray();
            var parse = new CSharpParseOptions(lang, preprocessorSymbols: symbols);
            var trees = p.GetProperty("sources").EnumerateArray().Select(x => x.GetString()!)
                .Select(path => CSharpSyntaxTree.ParseText(File.ReadAllText(path), parse, path)).ToList();
            if (p.GetProperty("implicit").GetBoolean()) trees.Add(CSharpSyntaxTree.ParseText(
                "global using System; global using System.Collections.Generic; global using System.IO; global using System.Linq; global using System.Net.Http; global using System.Threading; global using System.Threading.Tasks;", parse));
            var refs = new List<MetadataReference>(framework);
            foreach (var r in p.GetProperty("references").EnumerateArray()) refs.Add(Compile(r.GetString()!).ToMetadataReference());
            var nullableText = p.GetProperty("nullable").GetString();
            var nullable = nullableText == "enable" ? NullableContextOptions.Enable :
                nullableText == "warnings" ? NullableContextOptions.Warnings :
                nullableText == "annotations" ? NullableContextOptions.Annotations : NullableContextOptions.Disable;
            var options = new CSharpCompilationOptions(p.GetProperty("exe").GetBoolean() ? OutputKind.ConsoleApplication : OutputKind.DynamicallyLinkedLibrary,
                allowUnsafe: p.GetProperty("unsafe").GetBoolean(), nullableContextOptions: nullable);
            var compilation = CSharpCompilation.Create("snapshot_" + compiled.Count, trees, refs, options);
            compiled.Add(id, compilation); visiting.Remove(id);
            foreach (var d in compilation.GetDiagnostics()) {
                if (d.Severity != DiagnosticSeverity.Error && d.Severity != DiagnosticSeverity.Warning) continue;
                if (!d.Location.IsInSource || string.IsNullOrEmpty(d.Location.SourceTree?.FilePath)) {
                    if (d.Severity == DiagnosticSeverity.Error) gaps.Add(d.Id + ": " + d.GetMessage(System.Globalization.CultureInfo.InvariantCulture));
                    continue;
                }
                var span = d.Location.GetLineSpan();
                diagnostics.Add(new { file = d.Location.SourceTree!.FilePath,
                    zeile = span.StartLinePosition.Line + 1, spalte = span.StartLinePosition.Character + 1,
                    code = d.Id, meldung = d.GetMessage(System.Globalization.CultureInfo.InvariantCulture),
                    schwere = d.Severity == DiagnosticSeverity.Error ? "error" : "warning" });
            }
            return compilation;
        }
        Compile(input.GetProperty("selected").GetString()!);
        Console.WriteLine(JsonSerializer.Serialize(new { diagnostics, gaps }));
        return 0;
    }
}
