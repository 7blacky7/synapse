// Ghidra headless post-script: S2 fallback, S3 and graph from ONE analysis.
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.*;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressIterator;
import ghidra.program.model.symbol.*;
import java.io.BufferedWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;

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
    private String offset(Address a) { return Long.toUnsignedString(a.getOffset()); }
    private String target(String name, Address address) {
        return "\"name\":" + quote(name) + ",\"address_offset\":" + offset(address)
            + ",\"address_space\":" + quote(address.getAddressSpace().getName());
    }
    // Protected seam for the probe subclass; production always invokes the same decompiler.
    protected DecompileResults decompile(DecompInterface d, Function f, int timeout) throws Exception {
        return d.decompileFunction(f, timeout, monitor);
    }
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        // Limits are supplied by the existing runner grenzen contract (also used by the output guard).
        if (args.length != 4) throw new IllegalArgumentException("expected output, max entries/function, max chars/function, timeout");
        int maxEntries = Integer.parseInt(args[1]), maxChars = Integer.parseInt(args[2]), timeout = Integer.parseInt(args[3]);
        if (maxEntries < 1 || maxChars < 1 || timeout < 1) throw new IllegalArgumentException("invalid export limits");
        Path output = Paths.get(args[0]).toAbsolutePath().normalize();
        Files.createDirectories(output.getParent());
        DecompInterface decompiler = new DecompInterface();
        decompiler.openProgram(currentProgram);
        FunctionManager manager = currentProgram.getFunctionManager();
        ReferenceManager refs = currentProgram.getReferenceManager();
        Listing listing = currentProgram.getListing();
        long total = 0;
        for (FunctionIterator counter = manager.getFunctions(true); counter.hasNext(); counter.next()) total++;
        long done = 0;
        try (BufferedWriter writer = Files.newBufferedWriter(output, StandardCharsets.UTF_8)) {
            FunctionIterator functions = manager.getFunctions(true);
            while (functions.hasNext() && !monitor.isCancelled()) {
                Function function = functions.next();
                String body = "", status = "fehler";
                try {
                    DecompileResults result = decompile(decompiler, function, timeout);
                    boolean completed = result.decompileCompleted() && result.getDecompiledFunction() != null;
                    body = completed ? result.getDecompiledFunction().getC() : "";
                    String message = result.getErrorMessage() == null ? "" : result.getErrorMessage().strip();
                    status = completed ? "ok" : (message.isEmpty() ? "fehler" : message);
                } catch (Exception failure) { status = "decompiler_exception"; }
                boolean truncated = false;
                if (body.length() > maxChars) { body = body.substring(0, maxChars); truncated = true; }
                StringBuilder assembly = new StringBuilder();
                if (!"ok".equals(status)) {
                    InstructionIterator instructions = listing.getInstructions(function.getBody(), true);
                    int count = 0;
                    while (instructions.hasNext() && !monitor.isCancelled()) {
                        Instruction instruction = instructions.next();
                        String line = instruction.getAddress() + "  " + instruction.toString() + "\n";
                        if (count++ >= maxEntries || assembly.length() + line.length() > maxChars) { truncated = true; break; }
                        assembly.append(line);
                    }
                }
                List<Function> callees = new ArrayList<>(function.getCalledFunctions(monitor));
                callees.sort(Comparator.comparing(Function::getEntryPoint));
                List<String> calls = new ArrayList<>(), references = new ArrayList<>();
                for (Function callee : callees) {
                    if (calls.size() >= maxEntries) { truncated = true; break; }
                    calls.add("{" + target(callee.getName(), callee.getEntryPoint()) + ",\"external\":" + callee.isExternal() + "}");
                }
                AddressIterator sources = refs.getReferenceSourceIterator(function.getBody(), true);
                int scanned = 0, chars = 0;
                Set<String> seen = new HashSet<>();
                while (sources.hasNext() && !monitor.isCancelled()) {
                    Address source = sources.next();
                    if (scanned++ >= maxEntries) { truncated = true; break; }
                    for (Reference ref : refs.getReferencesFrom(source)) {
                        if (references.size() >= maxEntries) { truncated = true; break; }
                        Address address = ref.getToAddress();
                        Function callee = manager.getFunctionAt(address);
                        if (callee != null && !callee.isExternal()) continue; // represented by callees
                        Data data = listing.getDefinedDataContaining(address);
                        Symbol symbol = currentProgram.getSymbolTable().getPrimarySymbol(address);
                        String kind = callee != null ? "import" : data != null && data.hasStringValue() ? "string" : "data";
                        if (data == null && callee == null && symbol == null) continue;
                        String name = callee != null ? callee.getName() : symbol != null ? symbol.getName() : "DAT_" + address;
                        String value = data != null && data.hasStringValue() ? String.valueOf(data.getValue()) : name;
                        String key = source + ":" + address + ":" + kind;
                        if (!seen.add(key)) continue;
                        String item = "{" + target(name, address) + ",\"from_offset\":" + offset(source)
                            + ",\"kind\":" + quote(kind) + ",\"value\":" + quote(value)
                            + ",\"external\":" + (callee != null && callee.isExternal()) + "}";
                        if (chars + item.length() > maxChars) { truncated = true; break; }
                        references.add(item); chars += item.length();
                    }
                    if (truncated && (references.size() >= maxEntries || chars >= maxChars)) break;
                }
                writer.write("{\"name\":" + quote(function.getName())
                    + ",\"address\":" + quote(function.getEntryPoint().toString())
                    + ",\"address_offset\":" + offset(function.getEntryPoint())
                    + ",\"size\":" + function.getBody().getNumAddresses()
                    + ",\"thunk\":" + function.isThunk()
                    + ",\"prototype\":" + quote(function.getSignature().getPrototypeString())
                    + ",\"decompiled\":" + quote(body)
                    + ",\"decompile_status\":" + quote(status)
                    + ",\"assembly\":" + quote(assembly.toString())
                    + ",\"callees\":[" + String.join(",", calls) + "]"
                    + ",\"references\":[" + String.join(",", references) + "]"
                    + ",\"export_truncated\":" + truncated + "}");
                writer.newLine();
                done++;
                if (done % 100 == 0) println("RV_PROGRESS " + done + " " + total);
            }
        } finally { decompiler.dispose(); }
        println("RV_DONE " + done + " " + total);
    }
}
