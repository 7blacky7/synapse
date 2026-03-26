# REST API Code-Write + Dual-Watcher

**Datum:** 2026-03-27
**Status:** Design
**Scope:** packages/rest-api, packages/core (watcher)

## Motivation

Web-KIs (Claude Web, ChatGPT) nutzen Synapse ueber die REST API — sie haben keinen MCP-Zugriff. Aktuell koennen sie Code nur LESEN (search, memory, thoughts). Mit Code-Intelligence liegt der gesamte Code jetzt in PostgreSQL. Web-Agenten sollen Code auch SCHREIBEN und AENDERN koennen — direkt in PG, ohne Filesystem-Zugriff.

Wenn ein Projekt auf einem PC aktiv ist (MCP-Server + FileWatcher laufen), sollen externe PG-Aenderungen automatisch auf die Festplatte gesynct werden.

## Architektur

```
Web-Agent (Claude/GPT)
    |
    v
REST API (Unraid Docker)
    |
    v
PostgreSQL (code_files.content aendern)
    |                              |
    v                              v
parseAndEmbed()              PG-Watcher (wenn Projekt aktiv auf PC)
    |                              |
    v                              v
code_symbols + Qdrant        Filesystem-Write
                                   |
                                   v
                              FileWatcher (Filesystem-Event)
                                   |
                                   v
                              storeFileContent() → Hash gleich → STOP
```

## Teil 1: REST API — Neue Routes

### routes/code-intel.ts (NEU)

Alle 7 code_intel Actions als REST Endpoints. Lesen die gleichen Core-Funktionen wie das MCP-Tool.

```
GET /api/projects/:name/code-intel/tree
    ?path=src/services&depth=1&show_functions=true&show_comments=false&show_lines=true
    &show_counts=true&show_imports=false&recursive=true&file_type=typescript

GET /api/projects/:name/code-intel/functions
    ?name=embed&file_path=embeddings/index.ts&exported_only=true

GET /api/projects/:name/code-intel/variables
    ?name=BASE_URL&with_values=true&file_path=embeddings

GET /api/projects/:name/code-intel/symbols
    ?symbol_type=interface&file_path=types/index.ts&name=Memory

GET /api/projects/:name/code-intel/references
    ?name=getPool

GET /api/projects/:name/code-intel/search
    ?query=FileWatcher+debounce&file_type=typescript&limit=10

GET /api/projects/:name/code-intel/file
    ?path=src/services/code.ts
```

Alle Endpoints geben JSON zurueck im gleichen Format wie das MCP-Tool. URL-Parameter nutzen `:name` (wie alle bestehenden Routes, z.B. `request.params.name`).

**Error Handling:** Gleiches Envelope wie bestehende Routes:
- 200: `{ success: true, ... }`
- 400: `{ success: false, error: { message: "..." } }` (fehlende Parameter)
- 404: `{ success: false, error: { message: "..." } }` (Projekt/Datei nicht gefunden)
- 500: `{ success: false, error: { message: "..." } }` (DB-Fehler)

### routes/files.ts (NEU)

Code schreiben, aendern, loeschen — nur in PostgreSQL. Kein Filesystem.

#### POST /api/projects/:name/files — Neue Datei erstellen

```json
{
  "file_path": "src/new-module/helper.ts",
  "content": "export function helper() { return 42; }"
}
```

Erstellt neuen Eintrag in `code_files` mit content + content_hash. Setzt `parsed_at = NULL` damit Parser drueberlaueft. Response: `{ success: true, file_path, content_hash, line_count }`.

#### PUT /api/projects/:name/files — Datei aendern

Unterstuetzt verschiedene Operations-Modi:

**Modus 1: Ganzen Inhalt ersetzen**
```json
{
  "file_path": "src/code.ts",
  "content": "kompletter neuer Inhalt"
}
```

**Modus 2: Zeilen ersetzen**
```json
{
  "file_path": "src/code.ts",
  "operation": "replace_lines",
  "line_start": 45,
  "line_end": 50,
  "content": "neuer Code fuer diese Zeilen"
}
```

**Modus 3: Zeilen einfuegen (nach Zeile X)**
```json
{
  "file_path": "src/code.ts",
  "operation": "insert_after",
  "after_line": 44,
  "content": "neue Zeilen die eingefuegt werden"
}
```

**Modus 4: Zeilen loeschen**
```json
{
  "file_path": "src/code.ts",
  "operation": "delete_lines",
  "line_start": 45,
  "line_end": 50
}
```

**Modus 5: Suchen und Ersetzen**
```json
{
  "file_path": "src/code.ts",
  "operation": "search_replace",
  "search": "const foo = 'bar'",
  "replace": "const foo = 'baz'"
}
```

**Modus 6: Datei verschieben/umbenennen**
```json
{
  "file_path": "src/old-name.ts",
  "operation": "move",
  "new_path": "src/new-module/new-name.ts"
}
```

Bei `move` werden alle FKs aktualisiert: `code_files.file_path`, `code_symbols.file_path`, `code_references.file_path`, `code_chunks.file_path`.

**Modus 7: Datei kopieren**
```json
{
  "file_path": "src/template.ts",
  "operation": "copy",
  "new_path": "src/new-module/from-template.ts"
}
```

**Zeilennummern sind 1-basiert** (wie in Editoren). Zeile 1 = erste Zeile der Datei.

**Logik fuer alle Modi:**
1. Aktuellen `content` aus PG lesen (`SELECT content FROM code_files WHERE project = $1 AND file_path LIKE '%' || $2`)
2. Operation anwenden (Zeilen splitten, ersetzen, einfuegen, etc.)
3. Neuen `content_hash` berechnen (SHA-256)
4. PG updaten: `content`, `content_hash`, `updated_at = NOW()`, `parsed_at = NULL`
5. `parseAndEmbed(project, filePath)` aus `@synapse/core` (Datei: `packages/core/src/services/code.ts`) aufrufen — **fire-and-forget** (nicht awaiten, Response sofort zurueck). Parser + Qdrant-Embedding laufen im Hintergrund.
6. Response: `{ success, file_path, content_hash, line_count, operation }`

**`parseAndEmbed` Referenz:** Exportiert aus `@synapse/core`, Signatur: `parseAndEmbed(project: string, filePath: string): Promise<void>`. Liest Content aus PG, parst Symbole in code_symbols, erstellt Chunks in code_chunks, embedded nach Qdrant. Async — Route wartet NICHT auf Completion.

**search_replace bei 0 Treffern:** Response mit `{ success: true, count: 0, message: "Suchtext nicht gefunden, keine Aenderung" }`. HTTP 200, Content bleibt unveraendert. Der Agent entscheidet ob er es nochmal versucht.

**copy:** Erstellt neue Row in code_files mit `parsed_at = NULL`. `parseAndEmbed()` wird getriggert — Symbole und Vektoren fuer die Kopie werden separat erstellt.

**move — Qdrant:** Nach dem FK-Update in PG werden die alten Qdrant-Vektoren geloescht und `parseAndEmbed()` fuer den neuen Pfad getriggert. Das erzeugt neue Vektoren mit korrektem `file_path` Payload.

#### DELETE /api/projects/:name/files — Datei loeschen

```json
{
  "file_path": "src/old-file.ts"
}
```

Setzt `deleted_at = NOW()` in `code_files` (Soft-Delete). CASCADE loescht symbols, references, chunks NICHT sofort — erst nach Filesystem-Sync.

Ablauf:
1. API: `UPDATE code_files SET deleted_at = NOW() WHERE project = $1 AND file_path LIKE '%' || $2`
2. PG-Watcher auf PC: erkennt `deleted_at IS NOT NULL` → loescht Datei vom Filesystem
3. PG-Watcher: `DELETE FROM code_files WHERE id = $1` (CASCADE raeumt symbols, references, chunks auf)
4. Qdrant: `deleteByFilePath()` wird im Cleanup-Schritt aufgerufen
5. Response sofort: `{ success: true, file_path, message: "Zum Loeschen markiert" }`

Wenn kein Projekt aktiv ist (kein PG-Watcher laeuft): Soft-Delete bleibt stehen. Beim naechsten Init wird die Datei vom Filesystem geloescht und die Row endgueltig entfernt.

### Bestehende Routes aktualisieren

Die bestehende `routes/mcp.ts` (1413 Zeilen) muss NICHT geaendert werden — die neuen Routes sind separate Dateien.

**Route-Registrierung (2 Stellen):**
1. `routes/index.ts`: Exports hinzufuegen (`export { codeIntelRoutes } from './code-intel.js'` + `export { filesRoutes } from './files.js'`)
2. `server.ts`: `fastify.register()` Calls hinzufuegen — folge dem bestehenden Pattern (z.B. `app.register(memoryRoutes)`)

## Teil 2: FileWatcher — PG-Polling (Dual-Watcher)

### Konzept

Der FileWatcher in `packages/core/src/watcher/index.ts` bekommt einen zusaetzlichen PG-Poll-Loop. Er ueberwacht:
1. **Filesystem** (wie bisher) — Chokidar, add/change/unlink Events
2. **PostgreSQL** (NEU) — Polling alle 15s auf externe Aenderungen

### PG-Poll-Logik

**WICHTIG:** `code_files.file_path` speichert ABSOLUTE Pfade (z.B. `/home/blacky/dev/synapse/src/code.ts`). Der PG-Watcher nutzt diese direkt fuer Filesystem-Operationen. Kein `path.join(projectPath, ...)` noetig.

**Clock-Skew-Vermeidung:** Statt Client-Zeit wird `MAX(updated_at)` aus dem letzten Result-Set als Checkpoint verwendet. So ist es egal ob REST API (Unraid) und MCP-Server (PC) unterschiedliche Uhren haben.

```typescript
let lastPgCheck = new Date(0).toISOString(); // Start: Epoch (alles abholen)

setInterval(async () => {
  const pool = getPool();

  // 1. Geaenderte/neue Dateien: PG-Content ist neuer als lokale Datei
  const changed = await pool.query(
    `SELECT file_path, content, content_hash, updated_at
     FROM code_files
     WHERE project = $1 AND updated_at > $2
       AND content IS NOT NULL AND deleted_at IS NULL`,
    [projectName, lastPgCheck]
  );

  for (const row of changed.rows) {
    // file_path ist absolut — direkt verwenden
    const filePath: string = row.file_path;

    let localHash: string | null = null;
    if (existsSync(filePath)) {
      localHash = createHash('sha256').update(readFileSync(filePath, 'utf-8')).digest('hex');
    }

    if (localHash !== row.content_hash) {
      // PG ist neuer → auf Festplatte schreiben
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, row.content, 'utf-8');
      // FileWatcher feuert change/add-Event → storeFileContent() → Hash gleich → STOP
    }
  }

  // 2. Geloeschte Dateien (Soft-Delete via deleted_at)
  const deleted = await pool.query(
    `SELECT id, file_path FROM code_files
     WHERE project = $1 AND deleted_at IS NOT NULL AND deleted_at > $2`,
    [projectName, lastPgCheck]
  );

  for (const row of deleted.rows) {
    // Datei vom Filesystem loeschen
    if (existsSync(row.file_path)) {
      unlinkSync(row.file_path);
    }
    // Qdrant-Vektoren loeschen
    try {
      const collectionName = COLLECTIONS.projectCode(projectName);
      await deleteByFilePath(collectionName, row.file_path);
    } catch { /* Qdrant evtl. nicht erreichbar */ }
    // Row endgueltig loeschen (CASCADE raeumt symbols, refs, chunks auf)
    await pool.query('DELETE FROM code_files WHERE id = $1', [row.id]);
  }

  // Checkpoint: Hoechstes updated_at aus den Ergebnissen verwenden
  const allRows = [...changed.rows, ...deleted.rows];
  if (allRows.length > 0) {
    const maxUpdated = allRows.reduce((max, r) =>
      r.updated_at > max ? r.updated_at : max,
      lastPgCheck
    );
    lastPgCheck = typeof maxUpdated === 'string' ? maxUpdated : maxUpdated.toISOString();
  }
}, 15000);
```

### Loop-Vermeidung

1. API schreibt in PG → `content_hash = sha256(neuer_content)`
2. PG-Watcher erkennt Aenderung → schreibt auf Festplatte
3. FileWatcher feuert `change` → `storeFileContent()` berechnet Hash
4. Hash in PG == Hash der Datei → `return false` → kein Re-Parse
5. **STOP** — kein Loop

### Geloeschte Dateien ueber API

Soft-Delete mit `deleted_at` Spalte:

```sql
ALTER TABLE code_files ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
```

1. DELETE API setzt `deleted_at = NOW()` (Row bleibt in PG)
2. PG-Watcher erkennt `deleted_at IS NOT NULL` → loescht vom Filesystem + Qdrant
3. PG-Watcher loescht Row endgueltig: `DELETE FROM code_files WHERE id = $1` (CASCADE)
4. Wenn kein Projekt aktiv: Soft-Delete bleibt stehen, Cleanup bei naechstem Init

### Neue Dateien ueber API

Wenn `file_path` nicht auf der Festplatte existiert:
1. `mkdirSync(dirname(filePath), { recursive: true })` — Verzeichnis erstellen
2. `writeFileSync(filePath, content)` — Datei anlegen
3. FileWatcher erkennt `add` Event → `storeFileContent()` → Hash gleich → STOP

## Teil 3: Core Service — Zeilen-Operationen

Neue Datei `packages/core/src/services/code-write.ts` mit den Zeilen-Operationen.

**Alle Zeilennummern sind 1-basiert** (Zeile 1 = erste Zeile). Konsistent mit Editor-Konventionen und dem code_intel Tool.

```typescript
/** Ersetzt Zeilen lineStart bis lineEnd (1-basiert, inklusiv) mit neuem Content */
export function replaceLines(content: string, lineStart: number, lineEnd: number, newContent: string): string

/** Fuegt newContent nach afterLine ein (1-basiert). afterLine=0 → am Anfang einfuegen */
export function insertAfterLine(content: string, afterLine: number, newContent: string): string

/** Loescht Zeilen lineStart bis lineEnd (1-basiert, inklusiv) */
export function deleteLines(content: string, lineStart: number, lineEnd: number): string

/** Ersetzt alle Vorkommen von search mit replace. Gibt neuen Content + Anzahl Ersetzungen zurueck */
export function searchReplace(content: string, search: string, replace: string): { content: string; count: number }
```

Diese Funktionen arbeiten rein auf Strings — kein PG, kein Filesystem. Die REST API Route ruft sie auf, berechnet den neuen Hash, und speichert in PG.

**Validierung:** Alle Funktionen werfen einen Error wenn Zeilennummern ausserhalb des gueltigen Bereichs liegen (z.B. `lineStart > totalLines` oder `lineStart < 1`).

## Teil 4: Docker/Unraid

Keine Dockerfile-Aenderungen noetig — das bestehende Dockerfile baut bereits `@synapse/core` + `@synapse/rest-api`. Nach Implementation:

1. `pnpm build`
2. `docker build -t synapse-api .`
3. Auf Unraid deployen (Image aktualisieren)

## Dateien die geaendert/erstellt werden

### Neue Dateien
| Datei | Verantwortung |
|-------|---------------|
| `packages/rest-api/src/routes/code-intel.ts` | code_intel REST Endpoints (7 Actions) |
| `packages/rest-api/src/routes/files.ts` | File CRUD + Zeilen-Operationen |
| `packages/core/src/services/code-write.ts` | Reine String-Operationen fuer Zeilen-Edits |

### Geaenderte Dateien
| Datei | Aenderung |
|-------|-----------|
| `packages/rest-api/src/routes/index.ts` | Neue Routes registrieren |
| `packages/core/src/watcher/index.ts` | PG-Polling Loop hinzufuegen |
| `packages/core/src/db/schema.ts` | `deleted_at` Spalte fuer code_files |
| `packages/core/src/services/code.ts` | `removeFile()` setzt deleted_at statt sofort DELETE |

## Nicht im Scope

- Web-UI Aenderungen (kein Frontend)
- MCP-Tool Aenderungen (code_intel bleibt wie es ist)
- Authentifizierung (OAuth bleibt wie es ist)
- Concurrent-Edit-Locking (kommt spaeter wenn noetig)
- Undo/Redo (kommt spaeter)
