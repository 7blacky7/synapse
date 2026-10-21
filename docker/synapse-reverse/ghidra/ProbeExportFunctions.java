// Test-only headless script: force ONE decompiler failure, retain real Ghidra listing/graph.
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.listing.Function;
public class ProbeExportFunctions extends ExportFunctions {
    @Override
    protected DecompileResults decompile(DecompInterface d, Function f, int timeout) throws Exception {
        if ("entry".equals(f.getName())) throw new IllegalStateException("forced probe failure");
        return super.decompile(d, f, timeout);
    }
}
