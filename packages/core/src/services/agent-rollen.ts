/**
 * MODUL: Rollenbindung von Projekt-Regeln
 * ZWECK: Entscheidet, welche Regeln ein Agent beim Onboarding sieht, und meldet
 *        Tags, die eine Bindung nur VERMUTEN lassen.
 *
 * INPUT:
 *   - tags: string[] - die Tags einer Regel-Memory
 *   - rolle: AgentRolle - Rolle des fragenden Agenten
 *
 * OUTPUT:
 *   - Set<AgentRolle> | null: erlaubte Rollen, null = keine Beschraenkung
 *   - boolean: ob eine Regel fuer eine Rolle sichtbar ist
 *   - string[]: Verdachtsfaelle in den Tags
 *
 * NEBENEFFEKTE: keine (reine Funktionen)
 *
 * WARUM DIESE DATEI EXISTIERT:
 * Die Filterung stand doppelt im Code — einmal in der REST-API (routes/mcp.ts),
 * einmal im lokalen Weg (mcp-server/tools/onboarding.ts) — und verglich Tags
 * exakt gegen "coordinator-only", "specialist-only", "subagent-only". Zwei Folgen:
 *
 *   1. Die Rolle heisst im Code DEUTSCH (role === 'koordinator'), der Tag war
 *      ENGLISCH. Wer ihn intuitiv als "koordinator-only" setzt, erzeugt eine
 *      Regel, die an JEDE Rolle geht — ohne Fehlermeldung, ohne Hinweis.
 *   2. Zwei Implementierungen driften auseinander.
 *
 * Beides ist hier behoben: eine Quelle, und die Erkennung ist tolerant.
 */

/** Rollen, fuer die Regeln reserviert werden koennen. */
export type AgentRolle = 'koordinator' | 'spezialist' | 'subagent';

/**
 * Schreibweisen je Rolle. Absichtlich als Praefixe: damit greifen sowohl die
 * deutsche als auch die englische Form und uebliche Kuerzel.
 */
const ROLLEN_PRAEFIXE: Array<{ rolle: AgentRolle; praefixe: string[] }> = [
  { rolle: 'koordinator', praefixe: ['koordinator', 'coordinator', 'koord', 'coord'] },
  { rolle: 'spezialist', praefixe: ['spezialist', 'specialist', 'spez', 'spec'] },
  { rolle: 'subagent', praefixe: ['subagent', 'subagenten', 'sub'] },
];

/** Vereinheitlicht einen Tag: Kleinschreibung, Trennzeichen zu Bindestrich. */
function normalisiere(tag: string): string {
  return tag.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

/** Ordnet einen Bezeichner einer Rolle zu, oder null wenn keine passt. */
function rolleAus(bezeichner: string): AgentRolle | null {
  for (const { rolle, praefixe } of ROLLEN_PRAEFIXE) {
    if (praefixe.some((p) => bezeichner.startsWith(p))) return rolle;
  }
  return null;
}

/**
 * Liefert die Rollen, denen eine Regel vorbehalten ist — oder null, wenn sie
 * fuer alle gilt.
 *
 * Ausschlaggebend ist AUSSCHLIESSLICH die Endung "-only". Ein Rollenname allein
 * bindet NICHT, und das ist der entscheidende Punkt: Tags tragen meist ein
 * THEMA, keine Beschraenkung. Die Regel "regel-subagenten-statt-spezialisten"
 * traegt den Tag "subagenten", ist aber eine Anweisung AN DEN KOORDINATOR. Wer
 * auf den Rollennamen filtert, nimmt sie genau dem weg, fuer den sie gilt.
 *
 * Mehrere -only-Tags sind erlaubt und bedeuten "fuer diese Rollen".
 */
export function erlaubteRollen(tags: string[]): Set<AgentRolle> | null {
  const erlaubt = new Set<AgentRolle>();
  for (const rohTag of tags) {
    const tag = normalisiere(rohTag);
    if (!tag.endsWith('-only')) continue;
    const rolle = rolleAus(tag.slice(0, -'-only'.length));
    if (rolle) erlaubt.add(rolle);
  }
  return erlaubt.size > 0 ? erlaubt : null;
}

/** Ob eine Regel mit diesen Tags fuer die Rolle sichtbar ist. */
export function regelSichtbarFuer(tags: string[] | undefined, rolle: AgentRolle): boolean {
  const erlaubt = erlaubteRollen(tags ?? []);
  return erlaubt === null || erlaubt.has(rolle);
}

/**
 * Meldet Tags, bei denen eine Rollenbindung gemeint sein KOENNTE, aber nicht
 * wirksam ist. Bewusst nur ein Hinweis und kein Filter — ein falscher Verdacht
 * kostet einen Blick, ein falscher Filter versteckt Wissen, und das merkt niemand.
 *
 * Zwei Faelle:
 *   (a) "-only" gesetzt, aber die Rolle davor ist unbekannt (Tippfehler; der Tag
 *       hat nie gegriffen).
 *   (b) Ein Rollenname als Tag, ohne jede "-only"-Bindung: entweder nur das
 *       Thema gemeint — dann ist alles richtig — oder die Bindung wurde vergessen.
 */
export function tagVerdacht(tags: string[] | undefined): string[] {
  const liste = tags ?? [];
  const hinweise: string[] = [];
  const gebunden = erlaubteRollen(liste) !== null;

  for (const rohTag of liste) {
    const tag = normalisiere(rohTag);
    if (tag.endsWith('-only')) {
      if (!rolleAus(tag.slice(0, -'-only'.length))) {
        hinweiseHinzu(hinweise, `Tag "${rohTag}" endet auf -only, aber die Rolle davor ist unbekannt — dieser Tag greift nicht.`);
      }
      continue;
    }
    if (!gebunden && rolleAus(tag)) {
      hinweiseHinzu(hinweise, `Tag "${rohTag}" nennt eine Rolle, es gibt aber keine -only-Bindung — die Regel geht an ALLE Rollen. Falls Beschraenkung gewollt: "${tag}-only" ergaenzen.`);
    }
  }
  return hinweise;
}

/** Doppelte Hinweise vermeiden, wenn mehrere Tags dieselbe Rolle nennen. */
function hinweiseHinzu(hinweise: string[], text: string): void {
  if (!hinweise.includes(text)) hinweise.push(text);
}
