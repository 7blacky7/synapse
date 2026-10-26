/**
 * P22-T198 B: Herkunft von Zeichenbereichen waehrend der ECHTEN Anwende-Schleife.
 * Keine eigene Commit-/Such-Semantik: observe erhaelt wirkOp, Vorher und Nachher.
 * Kurze Stueckliste statt Array je Zeichen; neu erzeugter Text erbt seine Basisbereiche.
 * Batch-Edits und absolute Zeilen werden damit auf dieselbe Ausgangsbasis projiziert.
 */
import type { FileBatchOp } from './file-batch.js';
import { findeTreffer, findeSuchBereiche, searchReplace } from './code-write.js';

export type CoeditBasisRegion =
  | { file_path: string; kind: 'file'; anchor: string }
  | { file_path: string; kind: 'span'; start: number; end: number; anchor: string; insertAt?: number };
type Stueck = { laenge: number; basis?: number; ursprung?: CoeditBasisRegion[] };
type Datei = { laenge: number; stuecke: Stueck[] };
const ganz = (pfad: string, grund: string): CoeditBasisRegion => ({ file_path: pfad, kind: 'file', anchor: grund });
const ohneInsert = (r: CoeditBasisRegion): CoeditBasisRegion => {
  if (r.kind === 'file') return r;
  const { insertAt: _insert, ...rest } = r;
  return rest;
};

/** Nur Metadaten; keine Netzwerk-/PG-Zugriffe und keine Textkopie je Zeichen. */
export class CoeditRegionSpur {
  private dateien = new Map<string, Datei>();
  readonly regionen = new Map<number, CoeditBasisRegion[]>();
  constructor(basen: ReadonlyMap<string, string>) {
    for (const [pfad, text] of basen) this.dateien.set(pfad, {
      laenge: text.length, stuecke: text.length ? [{ laenge: text.length, basis: 0 }] : [],
    });
  }
  private datei(pfad: string): Datei {
    let d = this.dateien.get(pfad);
    if (!d) { d = { laenge: 0, stuecke: [] }; this.dateien.set(pfad, d); }
    return d;
  }
  private teile(d: Datei, von: number, bis: number): Stueck[] {
    const result: Stueck[] = [];
    let start = 0;
    for (const s of d.stuecke) {
      const a = Math.max(von, start), b = Math.min(bis, start + s.laenge);
      if (b > a) result.push({ ...s, laenge: b - a, ...(s.basis !== undefined ? { basis: s.basis + a - start } : {}) });
      start += s.laenge;
    }
    return result;
  }
  private projiziere(pfad: string, von: number, bis: number, einfuegung = false): CoeditBasisRegion[] {
    const d = this.datei(pfad);
    if (von < 0 || bis < von || bis > d.laenge) throw Error('Bereich ausserhalb des Anwende-Stands');
    const out: CoeditBasisRegion[] = [];
    let start = 0;
    // Punkte an unveraenderten Grenzen bevorzugen; kein breiter Ersatzbereich vom Nachbarstueck.
    if (von === bis) {
      for (const s of d.stuecke) {
        if (s.basis !== undefined && von >= start && von <= start + s.laenge) {
          const punkt = s.basis + von - start;
          return [{ file_path: pfad, kind: 'span', start: punkt, end: punkt, anchor: 'punkt:' + punkt,
            ...(einfuegung ? { insertAt: punkt } : {}) }];
        }
        start += s.laenge;
      }
      if (!d.stuecke.length) return [{ file_path: pfad, kind: 'span', start: 0, end: 0, anchor: 'punkt:0',
        ...(einfuegung ? { insertAt: 0 } : {}) }];
      start = 0;
    }
    for (const s of d.stuecke) {
      const ende = start + s.laenge;
      const trifft = von === bis ? von >= start && von <= ende : von < ende && bis > start;
      if (trifft) {
        if (s.basis !== undefined) {
          const a = s.basis + Math.max(von, start) - start, b = s.basis + Math.min(bis, ende) - start;
          out.push({ file_path: pfad, kind: 'span', start: a, end: b, anchor: 'span:' + a + ':' + b });
        } else {
          for (const r of s.ursprung ?? []) out.push(einfuegung && r.kind === 'span' && r.start === r.end
            ? { ...r, insertAt: r.start } : ohneInsert(r));
        }
      }
      start = ende;
    }
    if (!out.length) throw Error('Zeichenbereich ohne sichere Basiszuordnung');
    return out;
  }
  private spleiss(pfad: string, von: number, bis: number, neu: number, ursprung: CoeditBasisRegion[]): void {
    const d = this.datei(pfad);
    d.stuecke = [...this.teile(d, 0, von), ...(neu ? [{ laenge: neu, ursprung }] : []), ...this.teile(d, bis, d.laenge)];
    d.laenge += neu - (bis - von);
  }
  private textEdits(op: FileBatchOp, vorher: string): { text: string; regionen: CoeditBasisRegion[] } {
    let text = vorher;
    const out: CoeditBasisRegion[] = [];
    const edits = op.action === 'search_replace_batch' ? op.edits ?? []
      : [{ search: op.search ?? '', replace: op.replace ?? '', replace_all: op.replace_all }];
    for (const edit of edits) {
      const t = findeTreffer(text, edit.search, edit.replace);
      const treffer = findeSuchBereiche(text, t.suche);
      if (!treffer.length || (treffer.length > 1 && !edit.replace_all)) throw Error('Suchbereich nicht eindeutig');
      // Erst alle Treffer auf demselben Stand projizieren, dann rechts nach links spleissen.
      const splices = treffer.map(({ start, end }) => {
        const alt = text.slice(start, end), ersatz = t.ersatz;
        const nach = ersatz.length > alt.length && ersatz.startsWith(alt);
        const vor = ersatz.length > alt.length && ersatz.endsWith(alt);
        if (nach || vor) {
          const punkt = nach ? end : start;
          const normal = nach && ersatz.slice(alt.length).startsWith('\n') && text[punkt] === '\n' ? punkt + 1 : punkt;
          const regionen = this.projiziere(op.file_path, normal, normal, true);
          return { start: punkt, end: punkt, neu: ersatz.length - alt.length, regionen };
        }
        return { start, end, neu: ersatz.length, regionen: this.projiziere(op.file_path, start, end) };
      });
      out.push(...splices.flatMap(s => s.regionen));
      for (const s of [...splices].reverse()) this.spleiss(op.file_path, s.start, s.end, s.neu, s.regionen);
      text = searchReplace(text, t.suche, t.ersatz).content;
    }
    return { text, regionen: out };
  }
  /** Wird nur nach einer erfolgreich angewendeten Op aufgerufen. Bei Unsicherheit konservativ bleiben. */
  observe(op: FileBatchOp, index: number, vorher: string, nachher: string): void {
    try {
      if (this.datei(op.file_path).laenge !== vorher.length) throw Error('Spur passt nicht zum Anwende-Stand');
      if (op.action === 'search_replace' || op.action === 'search_replace_batch') {
        const r = this.textEdits(op, vorher);
        if (r.text !== nachher) throw Error('Suchprojektion weicht von der Anwende-Schleife ab');
        this.regionen.set(index, r.regionen);
        return;
      }
      if (op.action === 'insert_after' || op.action === 'replace_lines' || op.action === 'delete_lines') {
        const offsets = [0];
        for (let i = vorher.indexOf('\n'); i >= 0; i = vorher.indexOf('\n', i + 1)) offsets.push(i + 1);
        const von = op.action === 'insert_after' ? op.after_line ?? -1 : (op.line_start ?? 0) - 1;
        const bis = op.action === 'insert_after' ? von : op.line_end ?? -1;
        if (von < 0 || bis < von || von > offsets.length || bis > offsets.length) throw Error('Ungueltiger Zeilenbereich');
        const a = offsets[von] ?? vorher.length, b = offsets[bis] ?? vorher.length;
        const regionen = this.projiziere(op.file_path, a, b, op.action === 'insert_after');
        // Zeilen-Join kann am Dateiende den vorherigen Zeilenumbruch entfernen.
        // Der genaue zusammenhaengende Zeichenspleiss stammt deshalb aus Vorher/Nachher.
        let p = 0, s = 0;
        while (p < vorher.length && p < nachher.length && vorher[p] === nachher[p]) p++;
        while (s < vorher.length - p && s < nachher.length - p
          && vorher[vorher.length - 1 - s] === nachher[nachher.length - 1 - s]) s++;
        if (p < a || vorher.length - s > b) regionen.push(...this.projiziere(op.file_path, p, vorher.length - s));
        this.spleiss(op.file_path, p, vorher.length - s, nachher.length - p - s, regionen);
        this.regionen.set(index, regionen);
        return;
      }
      const regionen = [ganz(op.file_path, 'Op ' + index + ' ' + op.action + ':file')];
      if (op.new_path) regionen.push(ganz(op.new_path, 'Op ' + index + ' ' + op.action + ':target'));
      this.regionen.set(index, regionen);
      this.dateien.set(op.file_path, { laenge: nachher.length,
        stuecke: nachher.length ? [{ laenge: nachher.length, ursprung: regionen }] : [] });
      if (op.new_path) this.dateien.set(op.new_path, { laenge: vorher.length,
        stuecke: vorher.length ? [{ laenge: vorher.length, ursprung: [ganz(op.new_path, 'Op ' + index + ' ' + op.action + ':target')] }] : [] });
    } catch (error) {
      const regionen = [ganz(op.file_path, 'Op ' + index + ' ' + op.action + ':nicht_zuordenbar:' + (error instanceof Error ? error.message : String(error)))];
      this.regionen.set(index, regionen);
      this.dateien.set(op.file_path, { laenge: nachher.length,
        stuecke: nachher.length ? [{ laenge: nachher.length, ursprung: regionen }] : [] });
    }
  }
}
