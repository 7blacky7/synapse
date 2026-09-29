#!/usr/bin/env node
// messe-tool-schemas.mjs — P7-T16: Zeichen je Tool-Schema, absteigend. Nur lesend, ohne DB, kein Laufzeit-Eingriff.
//   stdio-MCP-Server (packages/mcp-server, consolidated) UND REST-Schema-Liste (rest-api routes/mcp.ts, MCP_TOOLS).
// Grobe Kontext-Schaetzung: Zeichen / 4 = Token. Aufruf: node scripts/messe-tool-schemas.mjs [Anzahl]
const n = Number(process.argv[2]) || 999;

function messe(tools) {
  const einzig = new Map();
  for (const t of tools) if (t && t.name) einzig.set(t.name, t);
  const zeilen = [...einzig.values()].map((t) => {
    const json = JSON.stringify(t);
    const props = t.inputSchema?.properties ?? {};
    const beschr = Object.values(props).reduce((s, p) => s + String(p?.description ?? '').length, 0);
    return { name: t.name, zeichen: json.length, token: Math.round(json.length / 4), toolText: String(t.description ?? '').length, paramTexte: beschr, params: Object.keys(props).length };
  }).sort((a, b) => b.zeichen - a.zeichen);
  const gesamt = zeilen.reduce((s, z) => s + z.zeichen, 0);
  return { zeilen, gesamt };
}

function ausgabe(titel, m) {
  console.log(`== ${titel} ==`);
  for (const z of m.zeilen.slice(0, n)) {
    console.log(`${z.name.padEnd(14)} ${String(z.zeichen).padStart(7)} Z  ~${String(z.token).padStart(5)} Tok  Tool-Text ${z.toolText}, Param-Texte ${z.paramTexte}, ${z.params} Params`);
  }
  console.log(`GESAMT ${titel}: ${m.zeilen.length} Tools, ${m.gesamt} Zeichen (~${Math.round(m.gesamt / 4)} Token)`);
}

// stdio
const stdioMod = await import('../packages/mcp-server/dist/tools/consolidated/index.js');
const stdioTools = [];
const sammle = (x) => {
  if (Array.isArray(x)) return x.forEach(sammle);
  if (x && typeof x === 'object' && x.definition && x.definition.name) stdioTools.push(x.definition);
  else if (x && typeof x === 'object' && x.name && x.inputSchema) stdioTools.push(x);
};
Object.values(stdioMod).forEach(sammle);
ausgabe('stdio', messe(stdioTools));

// REST
try {
  const restMod = await import('../packages/rest-api/dist/routes/mcp.js');
  if (Array.isArray(restMod.MCP_TOOLS)) ausgabe('REST', messe(restMod.MCP_TOOLS));
  else console.log('REST: MCP_TOOLS nicht exportiert');
} catch (err) {
  console.log(`REST: nicht messbar (${err instanceof Error ? err.message.split('\n')[0] : err})`);
}
process.exit(0); // die Imports halten Handles (DB-Pool) offen
