/**
 * P22-T199 (Entwurf 7efece9b P2/P3/P5, Nachtrag 0f1ce666 B5, Freigabe bf31526a): Op-Zustaende im gemeinsamen Plan bei
 * Produkt-Schalter coedit_ohne_gate EIN (coedit-methode.ts). Reine Funktionen ohne DB; Anwende-Schleife, Konfliktprojektion
 * und kleine Pruefung kommen als Werkzeuge aus file-batch.ts (kein Importzyklus, dieselbe Logik wie Trockenlauf und commit).
 *
 * ZUSTAENDE je Op (Index = op_index im offenen Plan, gespeichert in file_batch_plans.op_zustaende, Schema 168):
 *   gueltig        passt auf den Schatten der frueheren gueltigen Ops derselben Dateien, ueberschneidet keine fruehere
 *                  gueltige Op eines ANDEREN Autors und hat keinen Syntax-/Fehlermuster-Befund der Stufe error
 *                  -> wird beim naechsten commit geschrieben.
 *   fehlerhaft     Trockenlauf scheitert (grund) oder Pruefbefund (befund_ids); bleibt beim Autor im Plan, blockiert niemanden.
 *   konflikt       ueberschneidet eine fruehere gueltige Fremd-Op an derselben Stelle (mit); wer zuerst gueltig ist, gewinnt.
 *                  Gleiche Einfuegestelle und Aufsetzen auf fremden Text bleiben Hinweis (wie detectCrossAgentConflicts).
 *   drift          nach Teilcommit oder fremdem Schreiben nicht auf den neuen Dateistand abbildbar (setzt file-batch.ts).
 *   wartet_gruppe  selbst gueltig, aber ihre Gruppe ist noch nicht vollstaendig gueltig.
 * GRUPPEN (SOLL 5): optionales Op-Feld gruppe; Schluessel Autor + gruppe, damit fremde Ops nie eine Gruppe kapern. Eine Gruppe
 *   wird nur vollstaendig und gueltig committet und haelt nur sich selbst zurueck. Ohne gruppe ist jede Op eigenstaendig.
 *   wartet_gruppe zaehlt fuer den Schatten spaeterer Ops als gueltig (die Gruppe soll spaeter geschrieben werden).
 * KASKADE: wird eine Op (neu) bewertet, werden alle spaeteren Ops mit gemeinsamer Datei mitbewertet (ausser drift).
 * COMMIT (SOLL 3): kommitKandidaten nimmt gueltige Ops und vollstaendige Gruppen und entfernt im Fixpunkt jede Op (samt
 *   Gruppe), die in genau dieser Teilmenge nicht anwendbar ist, dort ueberschneidet oder einen Befund erzeugt - Gueltigkeit
 *   ist pfadabhaengig (z. B. eine Op setzt auf eine zurueckgehaltene auf).
 * Wirft nur, wenn ein Werkzeug wirft; die Werkzeuge aus file-batch.ts fangen ihre Fehler selbst.
 */

export type OpZustandArt = 'gueltig' | 'fehlerhaft' | 'konflikt' | 'drift' | 'wartet_gruppe';

export interface OpZustand {
  zustand: OpZustandArt;
  /** fehlerhaft/drift/wartet_gruppe/konflikt: Ursache in einem Satz. */
  grund?: string;
  /** fehlerhaft: sperrende Pruefbefunde (plan-befunde.ts PlanBefund.id). */
  befund_ids?: string[];
  /** konflikt: die fruehere gueltige Fremd-Op, die gewinnt. */
  mit?: { op_index: number; agent_id: string | null; reason: string };
  /** gesetzt, wenn die Op zu einer Gruppe gehoert. */
  gruppe?: string;
  /**
   * true: Zustand bleibt, bis der Autor die Op aendert (keine Kaskade). Gesetzt fuer einen Konflikt mit einer Op, die schon
   * geschrieben wurde - auf dem neuen Stand saehe die Op sonst gueltig aus und ueberschriebe die fremde Aenderung still.
   */
  fest?: boolean;
  bewertet_am: string;
}

/** Was das Modul von einer Op braucht (FileBatchOp erfuellt das). */
export interface CoeditZustandOp {
  file_path: string;
  new_path?: string;
  agent_id?: string;
  author_identity_id?: string;
  gruppe?: string;
}

export interface CoeditKonflikt {
  left_op_index: number;
  right_op_index: number;
  reason: string;
  message: string;
}

export interface CoeditZustandWerkzeuge<Op extends CoeditZustandOp> {
  /** Pfade einer Op (file_path, bei move/copy auch new_path) - touchedPaths. */
  pfade(op: Op): string[];
  /** Herkunftsschluessel (Autor) einer Op; Ops ohne Autor gehoeren dem Plan-Owner. */
  autor(op: Op): string;
  /**
   * Wendet ops in Plan-Reihenfolge auf die Basen an und laeuft bei Fehlern weiter; Indizes beziehen sich auf ops. Wirft nie.
   * P22-T201: darf asynchron sein (file-batch.ts nutzt dafuer den Schattenstand-Puffer, coedit-schatten-puffer.ts).
   */
  wendeAn(ops: Op[], basen: Map<string, string>): Array<{ index: number; message: string }> | Promise<Array<{ index: number; message: string }>>;
  /** Cross-Agent-Ueberschneidungen (detectCrossAgentConflicts); Indizes beziehen sich auf ops. */
  konflikte(ops: Op[], basen: Map<string, string>): CoeditKonflikt[];
  /** Kleine Pruefung (Syntax + Fehlermuster) des Schattens aus ops; je Index in ops die sperrenden Befund-IDs. */
  pruefe?(ops: Op[], basen: Map<string, string>): Promise<Map<number, string[]>>;
}

const ZUSTAENDE: readonly OpZustandArt[] = ['gueltig', 'fehlerhaft', 'konflikt', 'drift', 'wartet_gruppe'];

/** gueltig oder nur wegen der eigenen Gruppe zurueckgehalten (zaehlt fuer den Schatten spaeterer Ops). */
export function zaehltAlsGueltig(z: OpZustand | null | undefined): boolean {
  return z?.zustand === 'gueltig' || z?.zustand === 'wartet_gruppe';
}

/** Gruppenschluessel Autor + gruppe, oder null ohne Gruppe. */
export function gruppenSchluessel<Op extends CoeditZustandOp>(op: Op, w: Pick<CoeditZustandWerkzeuge<Op>, 'autor'>): string | null {
  const g = typeof op.gruppe === 'string' ? op.gruppe.trim() : '';
  return g ? w.autor(op) + '\u0000' + g : null;
}

function teiltDatei(a: string[], b: string[]): boolean {
  return a.some((pfad) => b.includes(pfad));
}

/** op_zustaende aus PG lesen: je Index ein gueltiger Eintrag oder null (unbewertet). */
export function leseOpZustaende(roh: unknown, anzahl: number): Array<OpZustand | null> {
  const liste = Array.isArray(roh) ? roh : [];
  return Array.from({ length: anzahl }, (_, i) => {
    const z = liste[i] as OpZustand | null | undefined;
    return z && typeof z === 'object' && ZUSTAENDE.includes(z.zustand) ? z : null;
  });
}

/**
 * Gruppenregel anwenden: Mitglieder einer Gruppe, in der nicht alle gueltig sind, werden wartet_gruppe; ist die Gruppe
 * (wieder) vollstaendig gueltig, werden ihre Mitglieder gueltig.
 */
export function wendeGruppenAn<Op extends CoeditZustandOp>(
  ops: Op[], zustaende: OpZustand[], w: Pick<CoeditZustandWerkzeuge<Op>, 'autor'>, jetzt: string,
): OpZustand[] {
  const out = zustaende.map((z) => ({ ...z }));
  const gruppen = new Map<string, number[]>();
  ops.forEach((op, i) => {
    const g = gruppenSchluessel(op, w);
    if (g) gruppen.set(g, [...(gruppen.get(g) ?? []), i]);
  });
  for (const indizes of gruppen.values()) {
    const offen = indizes.filter((i) => !zaehltAlsGueltig(out[i]));
    for (const i of indizes) {
      if (!zaehltAlsGueltig(out[i])) { out[i] = { ...out[i], gruppe: ops[i].gruppe }; continue; }
      out[i] = offen.length > 0
        ? { zustand: 'wartet_gruppe', gruppe: ops[i].gruppe, bewertet_am: jetzt,
            grund: 'Gruppe ' + ops[i].gruppe + ' unvollstaendig: ' + offen.map((o) => 'Op ' + o + ' ' + out[o].zustand).join(', ') }
        : { zustand: 'gueltig', gruppe: ops[i].gruppe, bewertet_am: out[i].bewertet_am };
    }
  }
  return out;
}

/**
 * Bewertet die Ops mit Index in neu (plus Kaskade und alle noch unbewerteten Ops) gegen den Schatten der frueheren gueltigen
 * Ops derselben Dateien und wendet danach die Gruppenregel an. basen = aktueller Inhalt je Datei (Basis des offenen Plans).
 */
export async function bewerteOps<Op extends CoeditZustandOp>(args: {
  ops: Op[];
  zustaende: Array<OpZustand | null | undefined>;
  neu: number[];
  basen: Map<string, string>;
  w: CoeditZustandWerkzeuge<Op>;
  jetzt?: string;
}): Promise<OpZustand[]> {
  const { ops, basen, w } = args;
  const jetzt = args.jetzt ?? new Date().toISOString();
  const z: Array<OpZustand | null> = ops.map((_, i) => args.zustaende[i] ?? null);
  const ziel = new Set<number>();
  for (const i of args.neu) {
    if (!Number.isInteger(i) || i < 0 || i >= ops.length) continue;
    ziel.add(i);
    const pfade = w.pfade(ops[i]);
    for (let k = i + 1; k < ops.length; k++) {
      if (z[k]?.zustand !== 'drift' && !z[k]?.fest && teiltDatei(pfade, w.pfade(ops[k]))) ziel.add(k);
    }
  }
  ops.forEach((_, i) => { if (!z[i]) ziel.add(i); });

  const bewerteEine = async (i: number): Promise<OpZustand> => {
    const op = ops[i];
    const pfade = w.pfade(op);
    const vorher = ops.map((_, j) => j).filter((j) => j < i && zaehltAlsGueltig(z[j]) && teiltDatei(pfade, w.pfade(ops[j])));
    const teil = [...vorher.map((j) => ops[j]), op];
    const selbst = teil.length - 1;
    const fehler = (await w.wendeAn(teil, basen)).find((f) => f.index === selbst);
    if (fehler) return { zustand: 'fehlerhaft', grund: fehler.message, bewertet_am: jetzt };
    const konflikt = w.konflikte(teil, basen).find((k) => k.left_op_index === selbst || k.right_op_index === selbst);
    if (konflikt) {
      const j = vorher[konflikt.left_op_index === selbst ? konflikt.right_op_index : konflikt.left_op_index];
      if (j !== undefined && w.autor(ops[j]) !== w.autor(op)) {
        return { zustand: 'konflikt', grund: konflikt.message, mit: { op_index: j, agent_id: ops[j].agent_id ?? null, reason: konflikt.reason }, bewertet_am: jetzt };
      }
    }
    if (w.pruefe) {
      const befunde = (await w.pruefe(teil, basen)).get(selbst) ?? [];
      if (befunde.length > 0) return { zustand: 'fehlerhaft', grund: 'Pruefbefund (Syntax/Fehlermuster) an dieser Op', befund_ids: befunde, bewertet_am: jetzt };
    }
    return { zustand: 'gueltig', bewertet_am: jetzt };
  };

  for (const i of [...ziel].sort((a, b) => a - b)) z[i] = await bewerteEine(i);
  return wendeGruppenAn(ops, z as OpZustand[], w, jetzt);
}

/**
 * Commit-Auswahl (SOLL 3): gueltige Ops (wartet_gruppe nie), danach Fixpunkt ueber genau diese Teilmenge - nicht anwendbar,
 * Ueberschneidung oder Pruefbefund entfernt die Op samt ihrer Gruppe. Hoechstens Anzahl Ops + 1 Runden.
 */
export async function kommitKandidaten<Op extends CoeditZustandOp>(args: {
  ops: Op[];
  zustaende: Array<OpZustand | null | undefined>;
  basen: Map<string, string>;
  w: CoeditZustandWerkzeuge<Op>;
}): Promise<{ kandidaten: number[]; zurueckgehalten: Array<{ op_index: number; grund: string }>; runden: number }> {
  const { ops, basen, w } = args;
  let k = ops.map((_, i) => i).filter((i) => args.zustaende[i]?.zustand === 'gueltig');
  const zurueck: Array<{ op_index: number; grund: string }> = [];
  const nimmRaus = (i: number, grund: string) => {
    if (!k.includes(i)) return;
    const g = gruppenSchluessel(ops[i], w);
    const raus = g ? k.filter((j) => gruppenSchluessel(ops[j], w) === g) : [i];
    for (const j of raus) zurueck.push({ op_index: j, grund: j === i ? grund : 'Gruppe ' + ops[j].gruppe + ' mit Op ' + i + ' zurueckgehalten' });
    k = k.filter((j) => !raus.includes(j));
  };
  let runden = 0;
  while (k.length > 0 && runden <= ops.length) {
    runden++;
    const alt = [...k];
    const teil = alt.map((i) => ops[i]);
    const fehler = await w.wendeAn(teil, basen);
    if (fehler.length > 0) {
      for (const f of fehler) if (alt[f.index] !== undefined) nimmRaus(alt[f.index], 'in der Commit-Teilmenge nicht anwendbar: ' + f.message);
      continue;
    }
    const konflikte = w.konflikte(teil, basen);
    if (konflikte.length > 0) {
      for (const c of konflikte) {
        const spaeter = alt[Math.max(c.left_op_index, c.right_op_index)];
        if (spaeter !== undefined) nimmRaus(spaeter, 'Ueberschneidung in der Commit-Teilmenge: ' + c.message);
      }
      continue;
    }
    if (w.pruefe) {
      const mitBefund = [...(await w.pruefe(teil, basen))].filter(([, ids]) => ids.length > 0);
      if (mitBefund.length > 0) {
        for (const [index, ids] of mitBefund) if (alt[index] !== undefined) nimmRaus(alt[index], 'Pruefbefund in der Commit-Teilmenge: ' + ids.join(', '));
        continue;
      }
    }
    break;
  }
  return { kandidaten: k, zurueckgehalten: zurueck, runden };
}

/** Nach einem Teilcommit: alter op_index -> neuer op_index der verbleibenden Ops (geschriebene fallen heraus). */
export function restIndexAbbildung(anzahl: number, geschrieben: number[]): Map<number, number> {
  const weg = new Set(geschrieben);
  const abbildung = new Map<number, number>();
  let neu = 0;
  for (let i = 0; i < anzahl; i++) if (!weg.has(i)) abbildung.set(i, neu++);
  return abbildung;
}

/** Zaehlung je Zustand (Debug/Antwort). */
export function zustandsZaehlung(zustaende: Array<OpZustand | null | undefined>): Record<OpZustandArt | 'unbewertet', number> {
  const zaehlung = { gueltig: 0, fehlerhaft: 0, konflikt: 0, drift: 0, wartet_gruppe: 0, unbewertet: 0 } as Record<OpZustandArt | 'unbewertet', number>;
  for (const z of zustaende) zaehlung[z?.zustand ?? 'unbewertet']++;
  return zaehlung;
}
