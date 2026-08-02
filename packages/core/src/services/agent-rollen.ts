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

/** Wie viele Zeichen eine gekuerzte Regel behaelt. */
const REGEL_KURZFASSUNG_ZEICHEN = 220;

/** Tag, mit dem eine Regel den Volltext im Onboarding behaelt. */
const PFLICHT_TAG = 'pflicht';

export interface OnboardingRegel {
  name: string;
  /** Volltext — nur bei Pflicht-Regeln gesetzt. */
  content?: string;
  /** Anfang der Regel — bei allen anderen gesetzt. */
  auszug?: string;
  /** true, wenn der Volltext mitgeliefert wurde. */
  vollstaendig: boolean;
}

/**
 * Bereitet Projekt-Regeln fuer das Onboarding auf: Volltext nur dort, wo er noetig ist.
 *
 * ⚠️ WARUM GEKUERZT WIRD (Messung 02.08.2026).
 * Das Onboarding lieferte JEDE Regel im Volltext. Im Hauptprojekt sind das 34 Regeln mit
 * zusammen rund 65.000 Zeichen — und ein Agent bekommt sie nicht einmal, sondern bei jedem
 * Wechsel der Server-Kennung erneut. In der Nacht auf den 02.08. waren das fuenf Deploys in
 * neunzig Minuten, also fuenfmal das komplette Regelwerk an jeden Agenten.
 * Der groesste Teil davon ist Wissen, das dieser Agent nie braucht: die Deploy-Prozedur mit
 * SSH und Docker geht auch an einen, der weder das eine noch das andere hat.
 *
 * WAS BLEIBT: Regeln mit dem Tag "pflicht" kommen weiterhin vollstaendig — im Hauptprojekt
 * sechs Stueck mit knapp 15.000 Zeichen, darunter die Warnung, dass context-handoff.sh
 * niemals ueber die Synapse-Shell laufen darf (sie reisst sonst die Desktop-Sitzung mit).
 * Alle anderen kommen als Name plus Anfang; der Volltext ist einen Aufruf entfernt.
 *
 * ⚠️ BEWUSST KEIN NEUES ETIKETT. "pflicht" ist ein Tag, den es im Bestand schon gibt und der
 * schon benutzt wird. Ein neu erfundenes Merkmal muesste jemand an 34 Regeln nachtragen, und
 * genau das Vergessen solcher Nachtraege ist der Fehler, den diese Codebasis an anderer
 * Stelle teuer bezahlt hat.
 */
export function baueOnboardingRegeln(
  memories: Array<{ name: string; content: string; tags?: string[] }>,
): OnboardingRegel[] {
  return memories.map((m) => {
    const pflicht = (m.tags ?? []).some((t) => t?.toLowerCase().trim() === PFLICHT_TAG);
    if (pflicht) return { name: m.name, content: m.content, vollstaendig: true };
    return { name: m.name, auszug: kuerzeRegel(m.content), vollstaendig: false };
  });
}

/** Anfang einer Regel, an einer Wortgrenze abgeschnitten. */
function kuerzeRegel(content: string): string {
  const text = (content ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= REGEL_KURZFASSUNG_ZEICHEN) return text;
  const roh = text.slice(0, REGEL_KURZFASSUNG_ZEICHEN);
  const letzteLuecke = roh.lastIndexOf(' ');
  return `${letzteLuecke > REGEL_KURZFASSUNG_ZEICHEN * 0.6 ? roh.slice(0, letzteLuecke) : roh} …`;
}

/**
 * Der Hinweis, wie ein Agent an den Volltext einer gekuerzten Regel kommt.
 * Ohne diesen Satz ist die Kuerzung eine Unterschlagung.
 */
export function baueRegelAbrufHinweis(project: string, gekuerzt: number): string | undefined {
  if (gekuerzt <= 0) return undefined;
  return `${gekuerzt} Regel(n) sind gekuerzt. Volltext einzeln abrufen mit `
    + `memory(action:"read", project:"${project}", name:"<regel-name>"). `
    + `Regeln mit dem Tag "pflicht" stehen vollstaendig oben.`;
}
