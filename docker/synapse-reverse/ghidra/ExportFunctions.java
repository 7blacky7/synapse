// Ghidra headless post-script: one JSONL record per function, including its decompilation.
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.FunctionManager;
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
        FunctionManager manager = currentProgram.getFunctionManager();
        // P18-T69: getFunctionCount() zaehlt Externals (Imports) mit; gezaehlt wird, was auch exportiert wird.
        long total = 0;
        for (FunctionIterator counter = manager.getFunctions(true); counter.hasNext(); counter.next()) total++;
        long done = 0;
        try (BufferedWriter writer = Files.newBufferedWriter(output, StandardCharsets.UTF_8)) {
            FunctionIterator functions = manager.getFunctions(true);
            while (functions.hasNext() && !monitor.isCancelled()) {
                Function function = functions.next();
                DecompileResults result = decompiler.decompileFunction(function, 60, monitor);
                boolean completed = result.decompileCompleted() && result.getDecompiledFunction() != null;
                String body = completed ? result.getDecompiledFunction().getC() : "";
                // P18-T69: getErrorMessage() ist bei Erfolg "" (nicht null); massgeblich ist decompileCompleted().
                String message = result.getErrorMessage() == null ? "" : result.getErrorMessage().strip();
                String status = completed ? "ok" : (message.isEmpty() ? "fehler" : message);
                writer.write("{\"name\":" + quote(function.getName())
                    + ",\"address\":" + quote(function.getEntryPoint().toString())
                    + ",\"address_offset\":" + Long.toUnsignedString(function.getEntryPoint().getOffset())
                    + ",\"size\":" + function.getBody().getNumAddresses()
                    + ",\"thunk\":" + function.isThunk()
                    + ",\"prototype\":" + quote(function.getSignature().getPrototypeString())
                    + ",\"decompiled\":" + quote(body)
                    + ",\"decompile_status\":" + quote(status)
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
