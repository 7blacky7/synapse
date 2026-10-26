/**
 * P3-T16 (User-Idee 26.10.2026, thought ab1977fa; Skill taktik-wiederkehr-plaene; Entscheidung Koordinator 28878):
 * FUENF STANDARDPLAENE fuer wiederkehrende Arbeit, projektneutral: Deploy-Ablauf, Gesamt-Testlauf, Befunde & Regressionen,
 * Agenten & Uebergaben, Doku & Skills. Abgeleitet aus Synapse P17/P25 und den regel-Memories. Die Texte sind der Start; die
 * Taktik lebt im Skill taktik-wiederkehr-plaene (Section aenderungen) und wird je Projekt in den Plaenen weitergepflegt.
 * ANLEGEN: plan(action:"standard_plaene") - Standard ist eine Vorschau; vorschau:false legt an. Optional beim Projekt-Init
 *   (project init mit standard_plaene:true). Nachruesten bestehender Projekte per selbem Aufruf: Plaene, deren Namensstamm
 *   (Text vor ' (') schon vorkommt, werden NICHT doppelt angelegt (z. B. 'Deploy-Ablauf (wiederverwendbar)' zaehlt als vorhanden).
 * SCHALTER: Anlegen nur bei Produkt-Schalter wiederkehr_plaene EIN; die Vorschau geht immer (mit Debugzeile wiederkehr).
 * Angelegte Plaene sind wiederkehrend, nicht aktiv (ausser es ist der erste Plan des Projekts), Prioritaet mittel.
 */
import { createPlan, addTasksBatch, getAllePlaene } from './plans.js';
import { leseWiederkehrSchalter, wiederkehrDebug, type WiederkehrDebug } from './plan-wiederkehr.js';
import type { ProjectTask } from '../types/index.js';

export interface StandardTaskVorlage {
  title: string;
  description: string;
  priority: ProjectTask['priority'];
  einmalig?: boolean;
  abschluss?: boolean;
}

export interface StandardPlanVorlage {
  schluessel: 'deploy' | 'testlauf' | 'befunde' | 'agenten' | 'doku';
  name: string;
  description: string;
  goals: string[];
  tasks: StandardTaskVorlage[];
}

const GRUNDSCHEMA = 'GRUNDSCHEMA (Skill taktik-wiederkehr-plaene): Je Durchlauf EIN Lauf-Thought des Koordinators (Tags <kuerzel>-lauf, '
  + '<kuerzel>-lauf-<lauf-id>), seine ID steht im Auftrag jeder Task. Je Task ein frischer Agent, ein Teilbericht-thought mit Belegen '
  + 'und als letzte Aktion ein End-thought (Tag session-uebergabe). STOPP statt raten: rot, fremd oder nicht zuordenbar -> Befund-thought, '
  + 'eine Zeile im Channel, der Koordinator entscheidet. Die Abschluss-Task setzt die wiederkehrenden Tasks zurueck auf todo '
  + '(automatisch bei Schalter wiederkehr_plaene EIN).';

/** Die fuenf Vorlagen (Reihenfolge = Anlage-Reihenfolge). */
export const STANDARD_PLAENE: readonly StandardPlanVorlage[] = [
  {
    schluessel: 'deploy',
    name: 'Deploy-Ablauf (wiederkehrend)',
    description: 'ZIEL: Abgenommene Arbeit in kleinen, pruefbaren Schritten live bringen, mit Rollback.\n'
      + 'AUFBAU: D0 -> D1 -> D2 -> D3 -> D4 -> D5 je Lauf (wiederkehrend), D5 schliesst ab. Einmalig: Testdatenbank auf Schemastand.\n'
      + 'REGELN: Deploy-Schritte nur mit Koordinator-Auftrag bzw. Dauer-Freigabe des Users und nur bei vollstaendig gruenem Stand. '
      + 'Alles ueber die Projekt-Shell, nie force-push, Loeschen auf dem Zielsystem nur per Aufraeum-Skript, Geheimnisse nie ausgeben.\n'
      + 'LAUFDATEN: Vorlagen-Ordner mit stabilen Skripten (ohne Lauf-ID im Namen), Lauf-Ordner je Lauf, Lauf-Thought.\n' + GRUNDSCHEMA,
    goals: ['Deploy in kleinen Schritten mit frischem Agenten je Schritt', 'Nachziehen (Dienste, Aufraeumen) nie vergessen', 'Wiederverwendbar durch Zuruecksetzen der Tasks'],
    tasks: [
      { title: 'EINMALIG: Testdatenbank auf den Schemastand bringen', priority: 'high', einmalig: true,
        description: 'Einmal je Projekt: Testdatenbank auf den aktuellen Schemastand bringen (Schema-Code echt gegen die TESTdatenbank, Guard auf Name/Port). Danach ist das ein fester D2-Schritt.' },
      { title: 'D0 Integration: ein Commit je abgenommener Task', priority: 'high',
        description: 'Vorher Commit-Sperre im Channel ausrufen. Neuer Lauf-Branch von der Live-Basis. Je Datei der Welle belegen: Platte == letzte Version der Task, erster Vorher-Hash == Basis. UEBERLAGERUNG durch laufende Tasks: betroffene Dateien exakt aus den letzten Versionen der eigenen Task nachbauen (sha256-Beleg), Typpruefung gruen; fremde Aenderungen kommen in den naechsten Lauf. Unklar oder offene Abhaengigkeit: STOPP. Kontrolle: Diff Basis..Lauf == erwartete Dateiliste. Danach "D0 durch" im Channel.' },
      { title: 'D1 Vorbereitung: Basis pruefen, Vorlagen kopieren, Lauf-Thought', priority: 'high',
        description: 'Basis pruefen (Fast-Forward moeglich), Vorlagen nach <name>-<lauf-id> kopieren, Platzhalter ersetzen, jedes Skript VOLLSTAENDIG lesen. UI-Version bei UI-Aenderung erhoehen. Lauf-Thought ergaenzen. Kein Build, kein Push.' },
      { title: 'D2 Pruefen: Builds, Schema-Probe, Testdatenbank, Routen, Gesamttest', priority: 'high',
        description: 'Sauberer Worktree, Abhaengigkeiten nach Lockfile, Builds EINZELN mit Logdatei (nie durch eine Pipe; Exit-Code und Fehlerzaehler). Schema-Probe und Nachzug der TESTdatenbank, Routen-Check, Gesamt-Testlauf (Plan Gesamt-Testlauf statt Handliste). Fehler: STOPP, Worktree stehen lassen.' },
      { title: 'D3 Ausrollen: Push, Deploy, Verify, Rollback bei Fehler', priority: 'high',
        description: 'Vorher alle arbeitenden Agenten im Channel warnen (Dienst kurz weg). Lauf-Branch pushen (nie force), Deploy-Skript entkoppelt starten, Endmarke als EIN Job abwarten. Verify-Liste aus dem Lauf-Thought (Health, Auth, Ports, Fehlerzeilen 0, Schema bereit, Neustartzaehler 0, richtiges Image). Nur bei vollstaendig gruenem Verify Hauptbranch per Fast-Forward nachziehen. Fehler: Rollback auf den Vorgaenger, STOPP.' },
      { title: 'D4 Nachziehen: Dienste synchronisieren und neu starten, Aufraeumen', priority: 'high',
        description: 'PFLICHT, nie auslassen. Lokale Dienste synchronisieren; den Neustart macht, wer nicht ueber den Dienst selbst arbeitet. Aufraeumen auf dem Zielsystem NUR per Skript (das Skript ist massgeblich, nichts per Hand nachloeschen). Worktree entfernen.' },
      { title: 'D5 Abschluss: Gesamtbericht, Vorlagen pflegen, Tasks zuruecksetzen', priority: 'medium', abschluss: true,
        description: 'Teilberichte zu EINEM Bericht (Tag bericht). Bewaehrte Skripte zurueck in den Vorlagen-Ordner, alte Fassung als *.vor-<lauf-id>. Danach D0-D5 auf todo (D5 zuletzt; bei Schalter wiederkehr_plaene EIN automatisch beim done dieser Task).' },
    ],
  },
  {
    schluessel: 'testlauf',
    name: 'Gesamt-Testlauf (wiederkehrend)',
    description: 'ZIEL: EIN Gesamttest statt Handlisten und Mehrfachlaeufen. Der Agent testet nur seine neuen Tests einmal, der Koordinator liest dessen Job statt neu zu laufen, der Gesamtlauf laeuft genau einmal (in D2 bzw. auf Zuruf).\n'
      + 'AUFBAU: T1 einmalig (Laeufer bauen). Je Lauf: T2 -> T6 -> T3 -> T4 -> T5, T5 schliesst ab.\n'
      + 'REGELN: nur Testdatenbank; UI-/Browser-Tests seriell ohne Endlosschleifen; Screenshots je Lauf in eigenen Ordner; Herkunft-Labels und Debugzeile in jeder Pruefung; kein git, kein Deploy.\n' + GRUNDSCHEMA,
    goals: ['Alle Tests mit einem Aufruf, automatisch gefunden', 'Ergebnis auf einen Blick: gruen / bekannt rot / NEU rot / fehlend', 'Kein doppeltes Testen'],
    tasks: [
      { title: 'T1 EINMALIG: Gesamt-Testlaeufer bauen', priority: 'high', einmalig: true,
        description: 'Tests automatisch finden (keine Handliste), ein Aufruf (Projekt-Task test-alle), parallel begrenzt, Browser-Tests und Tests mit globalem Zustand seriell, Zeitlimit je Test. Bekannt-rot-Liste als Datei im Repo (Test, erwartete Fehlzahl, Grund, seit). Klassen gruen / bekannt rot / NEU rot / fehlend. Option nur-betroffene gegen eine Basis. Zusammenfassung plus JSON, Log je Test. Laufschutz: Stand am Anfang und Ende vergleichen.' },
      { title: 'T2 Testlauf vorbereiten', priority: 'medium',
        description: 'Stand festhalten (Commit/Arbeitsbaum, Anlass), Testdatenbank auf Schemastand, Bekannt-rot-Liste lesen, Browser erreichbar, Lauf-Thought anlegen.' },
      { title: 'T6 Testabdeckung je Task pruefen und ergaenzen (vor T3)', priority: 'medium',
        description: 'Fuer jede seit dem letzten Lauf erledigte Umsetzungs-Task die neuen Einheiten ermitteln (Dateiverlauf plus Code-Index) und gegen die Tests abgleichen. Luecken in den Test der Task ERGAENZEN, NICHT ausfuehren (nur Typpruefung). Ergebnis als thought an die Task gepinnt, Sammelzeile im Lauf-Thought.' },
      { title: 'T3 Gesamtlauf ausfuehren', priority: 'medium',
        description: 'EIN Job ueber die Projekt-Shell, Ergebnis (gruen / bekannt rot / NEU rot / fehlend, Dauer) an den Lauf-Thought. Wiederholung nur bei Wackler-Verdacht, dann als Wackler markieren.' },
      { title: 'T4 NEU rot auswerten', priority: 'medium',
        description: 'Nur wenn NEU rot > 0. Ursache ueber den Dateiverlauf eingrenzen (welche Task), Luecke aus T6 oder Regression unterscheiden. Befund-thought mit Fix-Vorschlag an die verursachende Task (Uebergabe an Plan Befunde & Regressionen). Besserungen melden, damit Bekannt-rot schrumpft. Ohne NEU rot: mit kurzem Vermerk erledigen.' },
      { title: 'T5 Abschluss und Zuruecksetzen', priority: 'low', abschluss: true,
        description: 'Eine Zeile Ergebnis plus thought-ID an den Koordinator, Lauf-Logs aufraeumen. Danach T2-T6 auf todo (T5 zuletzt; bei Schalter wiederkehr_plaene EIN automatisch beim done dieser Task). T1 bleibt done.' },
    ],
  },
  {
    schluessel: 'befunde',
    name: 'Befunde & Regressionen (wiederkehrend)',
    description: 'ZIEL: Kein Befund geht verloren, kein Agent repariert ungefragt. Kette: STOPP-Befund -> Fix-Vorschlag -> Fix-Task (legt nur der Koordinator an) -> Umsetzung -> Abnahme mit Belegen -> naechster Deploy.\n'
      + 'AUFBAU: B1 -> B2 -> B3 -> B4 -> B5 je Durchlauf (nach jedem Testlauf bzw. jeder Abnahmerunde), B5 schliesst ab.\n'
      + 'REGELN: Agenten legen keine Tasks an, sie melden Befunde als thought mit Fix-Vorschlag; rot ist rot; Belege sichtbar und maschinell.\n' + GRUNDSCHEMA,
    goals: ['Jeder Befund hat eine Einordnung und einen Fix-Vorschlag', 'Fixes werden mit Belegen abgenommen', 'Bekannt-rot-Liste schrumpft'],
    tasks: [
      { title: 'B1 Eingang sammeln', priority: 'medium',
        description: 'Befund-thoughts seit dem letzten Durchlauf (Testlauf T4, Abnahmen, Deploy-STOPPs, Channel) zu einer Liste mit IDs zusammenfassen.' },
      { title: 'B2 Einordnen je Befund', priority: 'medium',
        description: 'Echte Regression (verursachende Task ueber den Dateiverlauf) / veralteter Test (gewolltes neues Verhalten, mit Beleg) / bewusst rot (Vorschlag Bekannt-rot mit Grund) / Wackler / Produktfehler.' },
      { title: 'B3 Fix-Vorschlaege an die verursachenden Tasks', priority: 'medium',
        description: 'Je Befund ein Fix-Vorschlag als thought, an die verursachende Task gepinnt; Sammelzeile an den Koordinator. Der Koordinator legt die Fix-Tasks an (meist einmalig im passenden Plan).' },
      { title: 'B4 Abnahme der erledigten Fixes', priority: 'medium',
        description: 'Belege gegenlesen (erwartet vs. tatsaechlich, Antworten/Screenshots wirklich sichtbar), rot bleibt rot. Abgenommene Fixes fuer D0 des naechsten Deploys vormerken.' },
      { title: 'B5 Abschluss und Zuruecksetzen', priority: 'low', abschluss: true,
        description: 'Bereinigung der Bekannt-rot-Liste vorschlagen, Bericht, B1-B5 auf todo (automatisch bei Schalter wiederkehr_plaene EIN).' },
    ],
  },
  {
    schluessel: 'agenten',
    name: 'Agenten & Uebergaben (wiederkehrend)',
    description: 'ZIEL: Jeder Agent weiss, wer er ist, was er tut und wo er weitermacht. Kein Wissen nur im Verlauf.\n'
      + 'AUFBAU: A1 -> A2 -> A3 -> A4 -> A5 je Durchlauf (bei jedem Koordinator-Wechsel bzw. taeglich), A5 schliesst ab.\n'
      + 'REGELN: Anweisungen an arbeitende Agenten nur im Channel, Agenten erreichen den Koordinator direkt. Wecken im Harness per Direktnachricht des Koordinators; auf lange Jobs wartet der Koordinator extern und weckt danach - Agenten pollen nie. Wiederaufnahme ueber den Synapse-Verlauf, nicht ueber git.\n' + GRUNDSCHEMA,
    goals: ['Uebergaben bei 85-90 % Kontext vollstaendig', 'Ausweise, Namen und Task-Bindungen stimmen', 'Neue User-Vorgaben stehen als Regel bereit'],
    tasks: [
      { title: 'A1 Ausweise, Namen und Task-Bindungen abgleichen', priority: 'medium',
        description: 'Angemeldete Agenten, verwaiste Laeufe und Task-Bindungen gegen den Plan-Stand abgleichen, Abweichungen melden.' },
      { title: 'A2 Uebergaben pruefen', priority: 'medium',
        description: 'Agenten ueber ~85-90 % Kontext schreiben einen Uebergabe-thought (Tag session-uebergabe, task_id). Pruefen, dass jede in_progress-Task einen aktuellen Uebergabe- oder Bericht-thought hat.' },
      { title: 'A3 Koordinator-Handoff', priority: 'medium',
        description: 'Offene Laeufe, gebundene Tasks, wartende Freigaben und naechste Schritte in EINEM thought.' },
      { title: 'A4 Regeln nachziehen', priority: 'medium',
        description: 'Neue User-Vorgaben seit dem letzten Durchlauf (woertlich, mit Datum) als Regel-Memory vorschlagen bzw. anlegen (Koordinator). Vorher semantisch suchen und Vorhandenes ergaenzen statt neu anlegen. Doppelte und ueberholte Regeln melden.' },
      { title: 'A5 Abschluss und Zuruecksetzen', priority: 'low', abschluss: true,
        description: 'Bericht, A1-A5 auf todo (automatisch bei Schalter wiederkehr_plaene EIN).' },
    ],
  },
  {
    schluessel: 'doku',
    name: 'Doku & Skills (wiederkehrend)',
    description: 'ZIEL: Doku, Skills und Vorlagen folgen dem Code, nicht umgekehrt.\n'
      + 'AUFBAU: K1 -> K2 -> K3 -> K4 -> K5 je Durchlauf (nach jedem Deploy kurz, woechentlich voll), K5 schliesst ab.\n'
      + 'REGELN: Erst pruefen, ob es etwas schon gibt; Altlasten nur nach der Aufraeum-Regel des Projekts entfernen.\n' + GRUNDSCHEMA,
    goals: ['Doku und Tool-Beschreibungen aktuell', 'Fall-Skills decken neue Fehlbedienungen ab', 'Taktik und Vorlagen gepflegt'],
    tasks: [
      { title: 'K1 Doku abgleichen', priority: 'medium',
        description: 'READMEs und Tool-Beschreibungen gegen die seit dem letzten Durchlauf ausgerollten Tasks abgleichen (neue Aktionen, Schalter, Routen, Einstellwerte).' },
      { title: 'K2 Fall-Skills ergaenzen', priority: 'medium',
        description: 'Neue Fehlbedienungen und Faelle aus Befunden und Channel als Section ergaenzen bzw. vorschlagen.' },
      { title: 'K3 Vorlagen pflegen', priority: 'medium',
        description: 'Deploy- und Test-Vorlagen gegen die letzten Laeufe pruefen. Bewaehrtes zurueckfuehren, Altlasten (alte *-<lauf>-Kopien) nur nach der Aufraeum-Regel entfernen.' },
      { title: 'K4 Taktik pflegen', priority: 'medium',
        description: 'Was sich in den Durchlaeufen geaendert hat, in den Skill taktik-wiederkehr-plaene (Section aenderungen: Datum, Anlass, thought-ID) bzw. in diese Plaene uebernehmen.' },
      { title: 'K5 Abschluss und Zuruecksetzen', priority: 'low', abschluss: true,
        description: 'Bericht, K1-K5 auf todo (automatisch bei Schalter wiederkehr_plaene EIN).' },
    ],
  },
];

/** Namensstamm fuer den Abgleich mit vorhandenen Plaenen: Text vor ' (' bzw. '(', klein, ohne Leerraum am Rand. */
export function planNamensStamm(name: string): string {
  return name.split('(')[0].trim().toLowerCase();
}

export interface StandardPlanErgebnis {
  schluessel: StandardPlanVorlage['schluessel'];
  name: string;
  status: 'vorhanden' | 'anzulegen' | 'angelegt' | 'fehler';
  vorhanden_als?: string;
  plan?: string;
  tasks: number;
  fehler?: string;
}

export interface StandardPlaeneErgebnis {
  success: boolean;
  project: string;
  vorschau: boolean;
  plaene: StandardPlanErgebnis[];
  wiederkehr: WiederkehrDebug;
  message: string;
  error?: string;
}

/**
 * Legt die Standardplaene an (vorschau:false) bzw. zeigt, was angelegt wuerde (Standard). auswahl = Schluessel-Teilmenge.
 * Wirft nicht fuer einzelne Plaene: Fehler stehen je Plan im Ergebnis.
 */
export async function legeStandardPlaeneAn(
  project: string,
  optionen: { vorschau?: boolean; auswahl?: string[] } = {},
): Promise<StandardPlaeneErgebnis> {
  const vorschau = optionen.vorschau !== false;
  const schalter = await leseWiederkehrSchalter(project);
  const unbekannt = (optionen.auswahl ?? []).filter((s) => !STANDARD_PLAENE.some((v) => v.schluessel === s));
  if (unbekannt.length > 0) {
    return { success: false, project, vorschau, plaene: [], wiederkehr: wiederkehrDebug(schalter), error: 'vorlage_unbekannt',
      message: `Unbekannte Vorlage(n): ${unbekannt.join(', ')}. Erlaubt: ${STANDARD_PLAENE.map((v) => v.schluessel).join(', ')}.` };
  }
  const vorlagen = optionen.auswahl && optionen.auswahl.length > 0
    ? STANDARD_PLAENE.filter((v) => optionen.auswahl!.includes(v.schluessel)) : [...STANDARD_PLAENE];
  const vorhanden = await getAllePlaene(project);
  const plaene: StandardPlanErgebnis[] = vorlagen.map((v) => {
    const treffer = vorhanden.find((p) => planNamensStamm(p.name) === planNamensStamm(v.name));
    return treffer
      ? { schluessel: v.schluessel, name: v.name, status: 'vorhanden', vorhanden_als: `${treffer.kurz_id ?? treffer.id} "${treffer.name}"`, tasks: v.tasks.length }
      : { schluessel: v.schluessel, name: v.name, status: 'anzulegen', tasks: v.tasks.length };
  });
  const debug = wiederkehrDebug(schalter, { hinweis: schalter.aktiv ? undefined
    : 'Schalter wiederkehr_plaene AUS: nur Vorschau. Einschalten: admin(action:"profil_schalter_setzen", profil_funktion:"wiederkehr_plaene", aktiv:true, ebene:"projekt").' });
  if (vorschau) {
    const n = plaene.filter((p) => p.status === 'anzulegen').length;
    return { success: true, project, vorschau: true, plaene, wiederkehr: debug,
      message: `Vorschau: ${n} von ${plaene.length} Standardplaenen wuerden angelegt (vorhandene werden nicht doppelt angelegt). Anlegen: plan(action:"standard_plaene", vorschau:false).` };
  }
  if (!schalter.aktiv) {
    return { success: false, project, vorschau: false, plaene, wiederkehr: debug, error: 'schalter_aus',
      message: 'Nichts angelegt: Produkt-Schalter wiederkehr_plaene ist AUS (Standard).' };
  }
  for (const p of plaene) {
    if (p.status !== 'anzulegen') continue;
    const v = vorlagen.find((x) => x.schluessel === p.schluessel)!;
    try {
      const plan = await createPlan(project, v.name, v.description, v.goals, { wiederkehrend: true, prioritaet: 'mittel' });
      const erg = await addTasksBatch(project, v.tasks.map((t) => ({ ...t })), plan.id);
      p.status = 'angelegt';
      p.plan = plan.kurz_id ?? plan.id;
      p.tasks = erg.tasks.length;
    } catch (e) {
      p.status = 'fehler';
      p.fehler = String((e as Error)?.message ?? e).slice(0, 300);
    }
  }
  const angelegt = plaene.filter((p) => p.status === 'angelegt').length;
  const fehler = plaene.filter((p) => p.status === 'fehler').length;
  console.error(`[Synapse] Standardplaene fuer "${project}": ${angelegt} angelegt, ${fehler} Fehler`);
  return { success: fehler === 0, project, vorschau: false, plaene, wiederkehr: debug,
    message: `${angelegt} Standardplaene angelegt${fehler ? `, ${fehler} mit Fehler` : ''}; vorhandene uebersprungen.` };
}

/** Projekt-Init (project init, standard_plaene:true): best effort, wirft nie. Ohne Wunsch kein Feld (Altverhalten). */
export async function standardPlaeneBeiInit(gewuenscht: unknown, project: string | null | undefined): Promise<Record<string, unknown>> {
  if (gewuenscht !== true || !project) return {};
  try {
    return { standard_plaene: await legeStandardPlaeneAn(project, { vorschau: false }) };
  } catch (e) {
    return { standard_plaene: { success: false, message: `Standardplaene nicht angelegt: ${String((e as Error)?.message ?? e).slice(0, 200)}` } };
  }
}
