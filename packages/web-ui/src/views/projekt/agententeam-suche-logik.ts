import type { ProjectTeamAgentViewModel } from '../../control-plane/view-model';
import type { ProfilWerte } from '../../api/ausweis-verwaltung';

/*
 * P22-T270 (User thought 9ddef22c + Nachtrag 7b25b0c1): Agententeam als Suche wie Channels (P22-T254) und Projektsuche (P22-T230).
 * Reine Logik ohne DOM/Netz (Test: web-ui/tests/agententeam-suche-p22-t270.test.mjs):
 *   - sortiereTeamSuche: Treffer der Suche (Name, Kennung, Rolle, Typ, Modell, Task), arbeitende/angemeldete zuerst, dann Name.
 *   - AUSWEIS_FELDER: NUR Felder, die es im Ausweis-Profil bereits gibt (dieselben wie Einstellungen > Agenten-Ausweis, P22-T68
 *     AusweisIdentitaetenPanel patchAus); kein neues Datenmodell. Channels laufen getrennt ueber das Channel-Icon.
 *   - patchAusEntwurf: nur geaenderte Felder; leerer Text = Feld leeren (null), Listen eine Zeile je Eintrag.
 *   - umschalteChannel: Channel dem Ausweis zuweisen bzw. wieder entziehen (Profilfeld channels).
 */

export const AUSWEIS_ERSTELLEN = 'Ausweis erstellen';

const rang = (a: ProjectTeamAgentViewModel): number =>
  a.busy ? 0 : a.status === 'running' || a.status === 'angemeldet' ? 1 : a.status === 'idle' ? 2 : 3;

/** P22-T289: Koordinator laut Ausweis-Rolle (Marke in der Liste, oben angeheftet). */
export const istKoordinator = (a: ProjectTeamAgentViewModel): boolean => /koordinator/i.test(a.rolle ?? '');

export function sortiereTeamSuche(agents: ProjectTeamAgentViewModel[], suche: string): ProjectTeamAgentViewModel[] {
  const q = suche.trim().toLocaleLowerCase();
  return agents
    .filter((a) => !q || [a.name, a.agentId, a.rolle, a.typ, a.model, a.currentTask].filter(Boolean).join(' ').toLocaleLowerCase().includes(q))
    // P22-T289 (User t239 „Koordinator aus dem Agententeam rausgenommen“): er stand nur alphabetisch weit unten. Koordinatoren zuerst.
    .sort((a, b) => Number(istKoordinator(b)) - Number(istKoordinator(a)) || rang(a) - rang(b) || a.name.localeCompare(b.name, 'de'));
}

export type FeldSchluessel = 'modell' | 'effort' | 'kontext_stufe' | 'briefing' | 'arbeitsweise' | 'regeln' | 'skills';
export type FeldArt = 'text' | 'mehrzeilig' | 'liste' | 'auswahl';
export interface AusweisFeld { schluessel: FeldSchluessel; label: string; art: FeldArt; hilfe: string; optionen?: readonly string[] }

export const AUSWEIS_FELDER: readonly AusweisFeld[] = [
  { schluessel: 'modell', label: 'Modell', art: 'text', hilfe: 'Modell des Agenten, z. B. opus' },
  { schluessel: 'effort', label: 'Effort', art: 'text', hilfe: 'Denkaufwand, z. B. high' },
  { schluessel: 'kontext_stufe', label: 'Kontextstufe', art: 'auswahl', hilfe: 'Ausgabestufe der Tool-Antworten', optionen: ['normal', 'kompakt', 'minimal'] },
  { schluessel: 'briefing', label: 'Briefing', art: 'mehrzeilig', hilfe: 'Auftrag und Rahmen beim Start' },
  { schluessel: 'arbeitsweise', label: 'Arbeitsweise', art: 'mehrzeilig', hilfe: 'Wie der Agent arbeitet' },
  { schluessel: 'regeln', label: 'Regeln', art: 'liste', hilfe: 'eine Regel je Zeile' },
  { schluessel: 'skills', label: 'Skills', art: 'liste', hilfe: 'ein Skill je Zeile' },
];

export type FeldEntwurf = Partial<Record<FeldSchluessel, string>>;

const zeilen = (text: string): string[] => text.split('\n').map((z) => z.trim()).filter(Boolean);
const gleich = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Wert eines Feldes aus den wirksamen Profilwerten als Text (Listen: eine Zeile je Eintrag). */
export function feldWert(w: ProfilWerte, s: FeldSchluessel): string {
  switch (s) {
    case 'modell': return w.modell;
    case 'effort': return w.effort;
    case 'kontext_stufe': return w.kontextStufe;
    case 'briefing': return w.briefing;
    case 'arbeitsweise': return w.arbeitsweise;
    case 'regeln': return w.regeln.join('\n');
    case 'skills': return w.skills.join('\n');
  }
}

/** Entwurf mit den Feldern, die im Ausweis schon belegt sind; leere Felder kommen ueber „Feld hinzufuegen“ dazu. */
export function entwurfAusWerten(w: ProfilWerte): FeldEntwurf {
  const e: FeldEntwurf = {};
  for (const f of AUSWEIS_FELDER) { const v = feldWert(w, f.schluessel); if (v.trim()) e[f.schluessel] = v; }
  return e;
}

export function fehlendeFelder(e: FeldEntwurf): AusweisFeld[] {
  return AUSWEIS_FELDER.filter((f) => !(f.schluessel in e));
}

/** Nur geaenderte Felder (gleiche Schluessel wie admin profil_aendern / AusweisIdentitaetenPanel patchAus). */
export function patchAusEntwurf(basis: ProfilWerte, e: FeldEntwurf): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const f of AUSWEIS_FELDER) {
    const neu = e[f.schluessel];
    if (neu === undefined) continue;
    const alt = feldWert(basis, f.schluessel);
    if (f.art === 'liste') { if (!gleich(zeilen(alt), zeilen(neu))) patch[f.schluessel] = zeilen(neu); continue; }
    if (f.art === 'auswahl') { if (neu && neu !== alt) patch[f.schluessel] = neu; continue; }
    if (alt !== neu) patch[f.schluessel] = neu.trim() ? neu : null;
  }
  return patch;
}

export function umschalteChannel(liste: string[], name: string): string[] {
  return liste.includes(name) ? liste.filter((c) => c !== name) : [...liste, name];
}

/** Zeile fuer das Fenster, wenn eine neu angelegte Identitaet noch nicht im Agententeam steht (Rueckfall ueber die Identitaetenliste). */
export function agentAusIdentitaet(z: { identityId: string; agentId: string; rolle: string; status: string }): ProjectTeamAgentViewModel {
  return {
    name: z.agentId, agentId: z.agentId, identityId: z.identityId, key: 'identity:' + z.identityId, art: 'identitaet', rolle: z.rolle,
    status: z.status, model: '', contextPercent: 0, tokensIn: 0, tokensOut: 0, channels: [], currentTask: '', busy: false, provider: '',
    lastActivity: '', source: 'api',
  };
}
