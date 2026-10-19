/**
 * P9-T30: Virtuelle (API-only) Systemprojekte.
 *
 * Ein virtuelles Projekt lebt nur auf der Synapse-API (Registry-Zeile hostname 'rest-api',
 * Pfad /virtual/*). Es wird NIE an einen PC gebunden, per restore_existing/Init lokal angelegt
 * oder von einem Daemon in config.json uebernommen.
 *
 * Achtung: registerVirtualProject legt fuer JEDES Projekt zusaetzlich eine rest-api-Zeile an
 * (REST-Zugang fuer Web-KIs). Diese Zeile allein macht ein Projekt NICHT virtuell — massgeblich
 * ist die ausdrueckliche Liste der Systemprojekte, erweiterbar per SYNAPSE_VIRTUELLE_PROJEKTE
 * (kommagetrennt, nur auf der API). Registry-Zeilen mit Pfad /virtual/* sind nie ein PC-Ort.
 */

/**
 * P22-T36 (W2-P1, User U1 39b8e0e9): reservierter Bereich der Hauptagenten-Identitaet. Der Hauptagent lebt nur in der
 * Web-UI; die Pflicht-Projektbindung seiner Identitaet ist intern. Virtuell (nie PC, nie Init/Restore, nie loeschbar)
 * und UNSICHTBAR (erscheint in keiner Projektliste, siehe istUnsichtbaresProjekt).
 */
export const HAUPTAGENT_PROJEKT = 'synapse-hauptagent';

/** Systemprojekte, die ausschliesslich auf der API existieren (reverse-bibliothek: REVERSE_PROJEKT der rest-api). */
export const VIRTUELLE_SYSTEMPROJEKTE: readonly string[] = Object.freeze(['reverse-bibliothek', HAUPTAGENT_PROJEKT]);
/** P22-T36: Systemprojekte, die in keiner Projektliste (project list, GET /api/projects, Web-UI, Graph) erscheinen. */
export const UNSICHTBARE_SYSTEMPROJEKTE: readonly string[] = Object.freeze([HAUPTAGENT_PROJEKT]);

export function istUnsichtbaresProjekt(name: unknown): boolean {
  return typeof name === 'string' && UNSICHTBARE_SYSTEMPROJEKTE.includes(name);
}
/** Hostname der virtuellen Registry-Zeile (registerVirtualProject). */
export const VIRTUELLER_HOST = 'rest-api';

export function virtuelleProjekte(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = String(env.SYNAPSE_VIRTUELLE_PROJEKTE ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...VIRTUELLE_SYSTEMPROJEKTE, ...extra])];
}

export function istVirtuellesProjekt(name: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof name === 'string' && virtuelleProjekte(env).includes(name);
}

/** Registry-Pfad der virtuellen Zeile ('/virtual/rest-api' u. a.) — nie ein Ort auf einem PC. */
export function istVirtuellerRegistryPfad(pfad: unknown): boolean {
  return typeof pfad === 'string' && (pfad === '/virtual' || pfad.startsWith('/virtual/'));
}

export class VirtuellesProjektFehler extends Error {
  readonly code = 'virtuelles_projekt';
  constructor(readonly project: string, wofuer: string) {
    super(`Projekt "${project}" ist ein virtuelles API-Projekt und wird nie an einen PC gebunden (${wofuer}).`);
    this.name = 'VirtuellesProjektFehler';
  }
}

/** Wirft VirtuellesProjektFehler, wenn name ein virtuelles Projekt ist. */
export function pruefeNichtVirtuell(name: string, wofuer: string): void {
  if (istVirtuellesProjekt(name)) throw new VirtuellesProjektFehler(name, wofuer);
}
