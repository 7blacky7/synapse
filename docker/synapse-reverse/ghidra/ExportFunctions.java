// Ghidra headless post-script: one JSONL record per function, including its decompilation.
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import java.io.BufferedWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

public class ExportFunctions extends GhidraScript {
    private String quote(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '\\': out.append("\\\\"); break;
                case '"': out.append("\\\""); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        return out.append('"').toString();
    }

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 1) throw new IllegalArgumentException("expected output JSONL path");
        Path output = Paths.get(args[0]).toAbsolutePath().normalize();
        Files.createDirectories(output.getParent());
        DecompInterface decompiler = new DecompInterface();
        decompiler.openProgram(currentProgram);
        long total = currentProgram.getFunctionManager().getFunctionCount();
        long done = 0;
        try (BufferedWriter writer = Files.newBufferedWriter(output, StandardCharsets.UTF_8)) {
            FunctionIterator functions = currentProgram.getFunctionManager().getFunctions(true);
            while (functions.hasNext() && !monitor.isCancelled()) {
                Function function = functions.next();
                DecompileResults result = decompiler.decompileFunction(function, 60, monitor);
                String body = result.decompileCompleted() ? result.getDecompiledFunction().getC() : "";
                writer.write("{\"name\":" + quote(function.getName())
                    + ",\"address\":" + quote(function.getEntryPoint().toString())
                    + ",\"prototype\":" + quote(function.getSignature().getPrototypeString())
                    + ",\"decompiled\":" + quote(body)
                    + ",\"decompile_status\":" + quote(result.getErrorMessage() == null ? "ok" : result.getErrorMessage())
                    + "}");
                writer.newLine();
                done++;
                if (done % 100 == 0) println("RV_PROGRESS " + done + " " + total);
            }
        } finally {
            decompiler.dispose();
        }
        println("RV_DONE " + done + " " + total);
    }
}
