/**
 * MODUL: Intern-Schalter (P14-T1, 11.10.2026)
 * ZWECK: Anhalte-Schalter fuer interne Ablaeufe (embedding, parser, context7) in PG, statt Pausen
 *        per SQL von Hand zu setzen. Gesetzt ueber das Tool 'intern' (nur bei SYNAPSE_INTERN_TOOL=1),
 *        gelesen von den Workern je Tick ueber leseSchalter() mit kurzem Cache.
 *
 * BEDEUTUNG: aktiv=true heisst "der Eingriff wirkt" (Ablauf angehalten). modus verfeinert das je
 *   Schalter: embedding 'hintergrund' | 'alle', parser und context7 'pause'.
 *   AUSNAHME tray_token_weiterleitung/freigegeben: aktiv=true/false ist ein befristeter
 *   EIN/AUS-Testoverride des Produktionsstandards; auch AUS bekommt eine Dauer.
 * HOECHSTDAUER: jeder Schalter laeuft ab (bis). Default und Obergrenze SYNAPSE_INTERN_MAX_STUNDEN
 *   (Default 12). Ohne Ablauf (bis NULL) nur mit dauerhaft:true. Abgelaufene Schalter gelten als aus;
 *   die Zeile bleibt zur Einsicht stehen.
 * CACHE: leseSchalter() fragt PG hoechstens alle SYNAPSE_INTERN_CACHE_MS (Default 5000) je Schalter.
 *   Der Ablauf wird bei jedem Lesen gegen die Uhr geprueft, nicht erst beim naechsten PG-Zugriff.
 *   setzeSchalter() setzt den Cache dieses Prozesses sofort auf den neuen Stand. Gleichzeitige Leser
 *   teilen sich eine Abfrage.
 * LESEFEHLER: Ist PG nicht erreichbar, antwortet nicht binnen 2 s oder fehlt die Tabelle, gilt der
 *   letzte bekannte Stand, ohne einen solchen "aus" — ein Worker laeuft lieber weiter, als an einem Lesefehler stehenzubleiben.
 *   Gemeldet wird das einmal, bis wieder ein Lesen gelingt.
 * NEBENEFFEKTE: nur Upsert in intern_schalter. Nichts wird beendet oder geloescht.
 */

import { aktuelleAgentAkteurIdentityId } from './agent-bezug.js';
import { getPool } from '../db/client.js';

/** Bekannte Schalter und ihre Modi; der erste Modus ist der Standard. */
export const INTERN_SCHALTER = {
  // P18-T76: temporary opt-in to PE resource extraction; production uses product switch.
  reverse_pe_ressourcen: ['freigegeben'],
  reverse_siedler3: ['freigegeben'],
  agentennetzwerk: ['freigegeben'],
  hex_lesen: ['freigegeben'],
  hex_adressen: ['freigegeben'],
  hex_formate: ['freigegeben'],
  hex_entschluesseln: ['freigegeben'],
  embedding: ['hintergrund', 'alle'],
  parser: ['pause'],
  context7: ['pause'],
  // Freigabe statt Pause: aktiv=true erlaubt ausschliesslich die lokale Tray-Token-Einsetzung.
  tray_token_weiterleitung: ['freigegeben'],
  // P22-T2: Hauptagent nur Synapse-MCP, kein eingebautes CLI-Werkzeug.
  main_synapse: ['freigegeben'],
  // P22-T10: aktiv=true gibt Token-Identitaet befristet frei (kein Pause-Schalter).
  token_identitaet: ['freigegeben'],
  agent_bezug_modus: ['alt', 'beide', 'neu'],
  // P22-T13: aktiv=true gibt W1b-Durchsetzung (F3, Profil-Gate) bzw. Antwortanpassung befristet frei.
  w1b_durchsetzung: ['freigegeben'],
  w1b_antwortanpassung: ['freigegeben'],
  // P22-T13 Paket B: Schattenprofil bei Legacy-Anmeldung, erster Koordinator, Koordinatorliste, Fortsetzung, Hinweisquellen.
  w1b_anmeldung: ['freigegeben'],
  // P22-T28 (V7): intern-Override des Produkt-Schalters agenten_ausweis (Ausweis-Kern); aktiv=true = freigegeben.
  agenten_ausweis: ['freigegeben'],
  // P22-T36 (W2-P1): intern-Override des Produkt-Schalters hauptagent (nur Tests, befristet); aktiv=true = freigegeben.
  hauptagent: ['freigegeben'],
  // P22-T8: intern-Override der Funktion api des Hauptagenten (kostenpflichtiger API-Agent; nur Tests, befristet).
  hauptagent_api: ['freigegeben'],
  // P22-T44: intern-Override des Produkt-Schalters mehrprojekt (Ausweis fuer mehrere Projekte); aktiv=true = freigegeben.
  mehrprojekt: ['freigegeben'],
  // P23-T1: befristete Test-Freigabe der Jev-Funktion skill_rerank (Produkt-Standard AUS); aktiv=true = freigegeben.
  skill_rerank: ['freigegeben'],
  // P23-T5: befristete Test-Freigabe der Fall-Skill-Funktionen (Produkt-Standard AUS); aktiv=true = freigegeben.
  tool_beschreibungen_kurz: ['freigegeben'],
  fall_skill_hinweis: ['freigegeben'],
  // P22-T56: befristete Test-Freigabe von tools/list je Verbindung (Produkt-Standard AUS); aktiv=true = freigegeben.
  tool_liste_je_verbindung: ['freigegeben'],
  // P23-T3: befristete Test-Freigabe schlanker Tool-Antworten (Produkt-Standard AUS); aktiv=true = freigegeben.
  tool_antworten_schlank: ['freigegeben'],
  // P23-T7: befristete Test-Freigabe der Tool-Faelle (ungenuegende Fall-Skill-Hinweise, Produkt-Standard AUS); aktiv=true = freigegeben.
  fall_skill_faelle: ['freigegeben'],
  // P23-T3 Punkt 6: befristete Test-Freigabe fremder Shell-Ergebnisse (Produkt-Standard AUS); aktiv=true = freigegeben.
  shell_fremde_ergebnisse: ['freigegeben'],
  // P16-T23: befristete Test-Freigabe des Build-Nachlaufs (Produkt-Standard AUS, build_einstellungen nachlauf); aktiv=true = freigegeben.
  build_nachlauf: ['freigegeben'],
  // P22-T7: befristete Test-Freigabe der Verbrauchszaehlung (Abo-Quellen, Produkt-Standard AUS); aktiv=true = freigegeben.
  verbrauch: ['freigegeben'],
  // P22-T58: befristete Test-Freigabe der Runtime-Ueberwachung (Produkt-Standard AUS); aktiv=true = freigegeben.
  runtime_ueberwachung: ['freigegeben'],
  // P22-T98: befristete Test-Freigabe von intern db_lesen/db_schema (Produkt-Standard AUS); aktiv=true = freigegeben.
  db_lesen: ['freigegeben'],
  // P18-T75: nur S3-Funktionsvergleich befristet freigeben; Produktbasis reverse_s3.
  reverse_vergleichen: ['freigegeben'],
  reverse_verknuepfungen: ['freigegeben'],
  reverse_erkenntnisse: ['freigegeben'],
  // P18-T85: befristete Test-Freigabe des Live-Fortschritts (Produktbasis reverse_fortschritt_live); aktiv=true = freigegeben.
  reverse_fortschritt_live: ['freigegeben'],
  reverse_blockuebernahme: ['freigegeben'],
  // P18-T94: befristeter EIN/AUS-Override, Produktstandard AUS.
  reverse_asset_registrierung: ['freigegeben'],
  reverse_parser_adapter: ['freigegeben'],
  // P18-T40: befristeter EIN/AUS-Override; Produktstandard AUS.
  reverse_leser: ['freigegeben'],
  reverse_leser_nachzug: ['freigegeben'],
  reverse_leser_hinweise: ['freigegeben'],
  reverse_leser_runtime_verwaltung: ['freigegeben'],
  // P18-T86: befristeter EIN/AUS-Testoverride (aktiv=true = EIN) der Produkt-Schalter reverse_entstoerer_auto / reverse_wav_pregap.
  reverse_entstoerer_auto: ['freigegeben'],
  reverse_wav_pregap: ['freigegeben'],
  // P18-T109: befristeter EIN/AUS-Testoverride der Produkt-Schalter (Standard AUS).
  reverse_global_sichtbar: ['freigegeben'],
  reverse_intel_abruf: ['freigegeben'],
  reverse_fehlerlog: ['freigegeben'],
  // P22-T105: befristete Test-Freigabe der Ausweis-Channels (Produkt-Standard AUS, ausweis-channels.ts); aktiv=true = freigegeben.
  ausweis_channels: ['freigegeben'],
} as const;
export type InternSchalterName = keyof typeof INTERN_SCHALTER;

export interface InternSchalterStand {
  stillgelegt?: boolean; nachfolger?: string;
  name: string;
  /** wirksam: gesetzt UND nicht abgelaufen */
  aktiv: boolean;
  /** Wert in PG, unabhaengig vom Ablauf */
  gesetzt: boolean;
  abgelaufen: boolean;
  modus: string | null;
  bis: string | null;
  dauerhaft: boolean;
  grund: string | null;
  gesetzt_von: string | null;
  gesetzt_am: string | null;
}

export interface SetzeSchalterOptionen {
  aktiv: boolean;
  modus?: string;
  /** ISO-Zeitpunkt */
  bis?: string;
  dauer_min?: number;
  dauerhaft?: boolean;
  grund?: string;
  agent?: string;
}

export class InternSchalterFehler extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

interface SchalterZeile {
  name: string;
  aktiv: boolean;
  modus: string | null;
  bis: Date | null;
  grund: string | null;
  gesetzt_von: string | null;
  gesetzt_am: Date | null;
}

const SPALTEN = 'name, aktiv, modus, bis, grund, gesetzt_von, gesetzt_am';

/** Hoechstdauer eines Schalters in ms (SYNAPSE_INTERN_MAX_STUNDEN, Default 12). */
export function hoechstdauerMs(): number {
  const stunden = Number(process.env.SYNAPSE_INTERN_MAX_STUNDEN);
  return (Number.isFinite(stunden) && stunden > 0 ? stunden : 12) * 3_600_000;
}

function cacheMs(): number {
  const wert = Number(process.env.SYNAPSE_INTERN_CACHE_MS);
  return Number.isFinite(wert) && wert >= 0 ? wert : 5000;
}

const cache = new Map<string, { zeile: SchalterZeile | null; geholt: number }>();
/** Schreibzaehler je Schalter: ein Lesen, das vor einem Schreiben begann, ueberschreibt den Cache nicht. */
const schreibStand = new Map<string, number>();
/** Laufende PG-Abfragen je Schalter — viele gleichzeitige Leser teilen sich eine. */
const laufend = new Map<string, Promise<SchalterZeile | null>>();
/** Hoechstens so lange wartet ein Worker auf das Lesen eines Schalters (volle Pools, haengende DB). */
const LESE_ZEITLIMIT_MS = 2000;
let lesefehlerGemeldet = false;

function alsStand(name: string, z: SchalterZeile | null, jetzt = Date.now()): InternSchalterStand {
  if (!z) {
    return {
      name, aktiv: false, gesetzt: false, abgelaufen: false, modus: null, bis: null,
      ...(name==='reverse_siedler3'?{stillgelegt:true,nachfolger:'reverse leser_liste'}:{}),
      dauerhaft: false, grund: null, gesetzt_von: null, gesetzt_am: null,
    };
  }
  const abgelaufen = (z.aktiv || name === 'reverse_siedler3' || name === 'reverse_verknuepfungen' || name === 'reverse_erkenntnisse' || name === 'reverse_fortschritt_live' || name === 'reverse_blockuebernahme' || name === 'reverse_asset_registrierung' || name === 'reverse_parser_adapter' || name === 'reverse_leser' || name === 'reverse_leser_nachzug' || name === 'reverse_leser_runtime_verwaltung' || name === 'reverse_leser_hinweise' || name === 'reverse_entstoerer_auto' || name === 'reverse_wav_pregap' || name === 'reverse_global_sichtbar' || name === 'reverse_intel_abruf' || name === 'reverse_fehlerlog' || name === 'agentennetzwerk' || name === 'tray_token_weiterleitung' || name === 'main_synapse' || name === 'token_identitaet' || name === 'agent_bezug_modus' || name === 'w1b_durchsetzung' || name === 'w1b_antwortanpassung' || name === 'w1b_anmeldung' || name === 'agenten_ausweis' || name === 'hauptagent' || name === 'hauptagent_api' || name === 'mehrprojekt' || (name === 'hex_lesen' || name === 'hex_adressen' || name === 'hex_formate' || name === 'hex_entschluesseln')) && z.bis !== null && z.bis.getTime() <= jetzt;
  return {
    name,
    aktiv: name==='reverse_siedler3'?false:z.aktiv && !abgelaufen,
    ...(name==='reverse_siedler3'?{stillgelegt:true,nachfolger:'reverse leser_liste'}:{}),
    gesetzt: z.aktiv,
    abgelaufen,
    modus: z.modus,
    bis: z.bis ? z.bis.toISOString() : null,
    dauerhaft: (z.aktiv || name === 'agent_bezug_modus' || ((name === 'reverse_siedler3' || name === 'reverse_verknuepfungen' || name === 'reverse_erkenntnisse' || name === 'reverse_fortschritt_live' || name === 'reverse_blockuebernahme' || name === 'reverse_asset_registrierung' || name === 'reverse_parser_adapter' || name === 'reverse_leser' || name === 'reverse_leser_nachzug' || name === 'reverse_leser_runtime_verwaltung' || name === 'reverse_leser_hinweise' || name === 'reverse_entstoerer_auto' || name === 'reverse_wav_pregap' || name === 'reverse_global_sichtbar' || name === 'reverse_intel_abruf' || name === 'reverse_fehlerlog' || name === 'agentennetzwerk' || name === 'tray_token_weiterleitung' || name === 'main_synapse' || name === 'token_identitaet' || name === 'agent_bezug_modus' || name === 'w1b_durchsetzung' || name === 'w1b_antwortanpassung' || name === 'w1b_anmeldung' || name === 'agenten_ausweis' || name === 'hauptagent' || name === 'hauptagent_api' || name === 'mehrprojekt' || (name === 'hex_lesen' || name === 'hex_adressen' || name === 'hex_formate' || name === 'hex_entschluesseln')) && z.modus === 'freigegeben')) && z.bis === null,
    grund: z.grund,
    gesetzt_von: z.gesetzt_von,
    gesetzt_am: z.gesetzt_am ? z.gesetzt_am.toISOString() : null,
  };
}

export function istSchalterName(name: string): name is InternSchalterName {
  return Object.prototype.hasOwnProperty.call(INTERN_SCHALTER, name);
}

/**
 * Setzt einen Schalter (Upsert). aktiv:true braucht hoechstens EINE Dauerangabe (bis | dauer_min |
 * dauerhaft); ohne Angabe gilt die Hoechstdauer, laengere Angaben werden auf sie gekappt (hinweis).
 */
export async function setzeSchalter(
  name: string,
  opt: SetzeSchalterOptionen,
): Promise<InternSchalterStand & { hinweis?: string }> {
  if (!istSchalterName(name)) {
    throw new InternSchalterFehler(
      'unbekannter_schalter',
      `Unbekannter Schalter "${name}". Erlaubt: ${Object.keys(INTERN_SCHALTER).join(', ')}.`,
    );
  }
  if(name==='reverse_siedler3')throw new InternSchalterFehler('funktion_stillgelegt','Siedler-3-Legacy ist stillgelegt; externen Leser verwenden.');
  const erlaubt: readonly string[] = INTERN_SCHALTER[name];
  let modus: string | null = null;
  let bis: Date | null = null;
  let hinweis: string | undefined;

  // Der Freigabeschalter braucht auch fuer einen AUS-Override einen Ablauf.
  if (opt.aktiv || name === 'reverse_verknuepfungen' || name === 'reverse_erkenntnisse' || name === 'reverse_fortschritt_live' || name === 'reverse_blockuebernahme' || name === 'reverse_asset_registrierung' || name === 'reverse_parser_adapter' || name === 'reverse_leser' || name === 'reverse_leser_nachzug' || name === 'reverse_leser_runtime_verwaltung' || name === 'reverse_leser_hinweise' || name === 'reverse_entstoerer_auto' || name === 'reverse_wav_pregap' || name === 'reverse_global_sichtbar' || name === 'reverse_intel_abruf' || name === 'reverse_fehlerlog' || name === 'agentennetzwerk' || name === 'tray_token_weiterleitung' || name === 'main_synapse' || name === 'token_identitaet' || name === 'agent_bezug_modus' || name === 'w1b_durchsetzung' || name === 'w1b_antwortanpassung' || name === 'w1b_anmeldung' || name === 'agenten_ausweis' || name === 'mehrprojekt' || (name === 'hex_lesen' || name === 'hex_adressen' || name === 'hex_formate' || name === 'hex_entschluesseln')) {
    modus = opt.modus ?? erlaubt[0];
    if (!erlaubt.includes(modus)) {
      throw new InternSchalterFehler('modus_ungueltig', `Modus "${modus}" passt nicht zu "${name}". Erlaubt: ${erlaubt.join(', ')}.`);
    }
    const angaben = [opt.bis !== undefined, opt.dauer_min !== undefined, opt.dauerhaft === true].filter(Boolean).length;
    if (angaben > 1) {
      throw new InternSchalterFehler('dauer_mehrdeutig', 'Hoechstens eines von bis, dauer_min, dauerhaft angeben.');
    }
    if (opt.dauerhaft !== true) {
      const jetzt = Date.now();
      const max = hoechstdauerMs();
      let ziel: number;
      if (opt.bis !== undefined) {
        ziel = Date.parse(opt.bis);
        if (!Number.isFinite(ziel)) throw new InternSchalterFehler('bis_ungueltig', `bis "${opt.bis}" ist kein Zeitpunkt (ISO, z. B. 2026-10-11T18:00:00+02:00).`);
        if (ziel <= jetzt) throw new InternSchalterFehler('bis_vergangen', `bis "${opt.bis}" liegt nicht in der Zukunft.`);
      } else if (opt.dauer_min !== undefined) {
        if (!Number.isFinite(opt.dauer_min) || opt.dauer_min <= 0) {
          throw new InternSchalterFehler('dauer_ungueltig', 'dauer_min muss eine Zahl > 0 sein.');
        }
        ziel = jetzt + opt.dauer_min * 60_000;
      } else {
        ziel = jetzt + max;
        hinweis = `Ohne Dauerangabe gilt die Hoechstdauer (${max / 3_600_000} h).`;
      }
      if (ziel - jetzt > max) {
        ziel = jetzt + max;
        hinweis = `Auf die Hoechstdauer gekappt (${max / 3_600_000} h, SYNAPSE_INTERN_MAX_STUNDEN). Ohne Ablauf nur mit dauerhaft:true.`;
      }
      bis = new Date(ziel);
    }
  }

  const { rows } = await getPool().query<SchalterZeile>(
    `INSERT INTO intern_schalter (name, aktiv, modus, bis, grund, gesetzt_von, gesetzt_am, setter_identity_id)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
     ON CONFLICT (name) DO UPDATE SET aktiv = EXCLUDED.aktiv, modus = EXCLUDED.modus, bis = EXCLUDED.bis,
       grund = EXCLUDED.grund, gesetzt_von = EXCLUDED.gesetzt_von, gesetzt_am = EXCLUDED.gesetzt_am, setter_identity_id=EXCLUDED.setter_identity_id
     RETURNING ${SPALTEN}`,
    [name, opt.aktiv, modus, bis, opt.grund ?? null, opt.agent ?? null, aktuelleAgentAkteurIdentityId(opt.agent)],
  );
  schreibStand.set(name, (schreibStand.get(name) ?? 0) + 1);
  cache.set(name, { zeile: rows[0] ?? null, geholt: Date.now() });
  return { ...alsStand(name, rows[0] ?? null), ...(hinweis ? { hinweis } : {}) };
}

/** Wirksamer Stand eines Schalters, gecacht (fuer Worker je Tick). Wirft nie. */
export async function leseSchalter(name: string): Promise<InternSchalterStand> {
  const jetzt = Date.now();
  const gemerkt = cache.get(name);
  if (gemerkt && jetzt - gemerkt.geholt < cacheMs()) return alsStand(name, gemerkt.zeile, jetzt);
  const standVorher = schreibStand.get(name) ?? 0;
  let abfrage = laufend.get(name);
  if (!abfrage) {
    abfrage = holeZeile(name).finally(() => laufend.delete(name));
    laufend.set(name, abfrage);
  }
  let zeile: SchalterZeile | null;
  try {
    zeile = await abfrage;
    if (lesefehlerGemeldet) {
      console.error('[Intern-Schalter] Lesen geht wieder.');
      lesefehlerGemeldet = false;
    }
  } catch (err) {
    if (!lesefehlerGemeldet) {
      console.error(`[Intern-Schalter] Lesen fehlgeschlagen, es gilt der letzte bekannte Stand: ${(err as Error).message}`);
      lesefehlerGemeldet = true;
    }
    zeile = gemerkt?.zeile ?? null;
  }
  // Wurde waehrend des Lesens geschrieben, ist der Cache schon neuer als diese Abfrage.
  if ((schreibStand.get(name) ?? 0) !== standVorher) return alsStand(name, cache.get(name)?.zeile ?? zeile);
  cache.set(name, { zeile, geholt: Date.now() });
  return alsStand(name, zeile);
}

async function holeZeile(name: string): Promise<SchalterZeile | null> {
  const abfrage = getPool()
    .query<SchalterZeile>(`SELECT ${SPALTEN} FROM intern_schalter WHERE name = $1`, [name])
    .then((r) => r.rows[0] ?? null);
  abfrage.catch(() => undefined); // verliert sie das Rennen gegen das Zeitlimit, bleibt ihr Fehler unbehandelt
  let zeitlimit: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      abfrage,
      new Promise<never>((_, reject) => {
        zeitlimit = setTimeout(() => reject(new Error(`Zeitlimit ${LESE_ZEITLIMIT_MS} ms`)), LESE_ZEITLIMIT_MS);
        zeitlimit.unref?.();
      }),
    ]);
  } finally {
    if (zeitlimit) clearTimeout(zeitlimit);
  }
}

/** Alle bekannten Schalter (auch nie gesetzte) frisch aus PG, ohne Cache. */
export async function alleSchalter(): Promise<InternSchalterStand[]> {
  const { rows } = await getPool().query<SchalterZeile>(`SELECT ${SPALTEN} FROM intern_schalter`);
  const jetzt = Date.now();
  const nachName = new Map(rows.map((z) => [z.name, z]));
  return Object.keys(INTERN_SCHALTER).map((name) => alsStand(name, nachName.get(name) ?? null, jetzt));
}

/** Zuletzt gemeldeter Zustand je Ablauf — Beginn und Ende einer Pause stehen genau einmal im Log. */
const gemeldet = new Map<string, boolean>();

/**
 * Fuer Worker (P14-T2): haelt der Schalter `name` den Ablauf `ablauf` gerade an, optional nur in
 * bestimmten Modi? Liefert dann den Stand, sonst null. Beginn und Ende stehen je Ablauf einmal im Log.
 */
export async function schalterHaeltAn(
  name: InternSchalterName,
  ablauf: string,
  modi?: readonly string[],
): Promise<InternSchalterStand | null> {
  const stand = await leseSchalter(name);
  const haelt = stand.aktiv && (!modi || modi.includes(stand.modus ?? ''));
  if (haelt !== (gemeldet.get(ablauf) ?? false)) {
    gemeldet.set(ablauf, haelt);
    console.error(haelt
      ? `[intern] ${ablauf} angehalten (Schalter ${name}${stand.modus ? `/${stand.modus}` : ''}, ${stand.dauerhaft ? 'dauerhaft' : `bis ${stand.bis}`}${stand.grund ? `, Grund: ${stand.grund}` : ''})`
      : `[intern] ${ablauf} laeuft wieder (Schalter ${name} aus)`);
  }
  return haelt ? stand : null;
}

/**
 * Nebenlaeufige Embedding-Nachtraege (embedde*Nach) bei Schalter embedding (jeder Modus) auslassen:
 * embedded_at bleibt NULL, der Backlog holt den Eintrag nach der Freigabe nach.
 */
export async function embeddingNachtragAngehalten(): Promise<boolean> {
  return (await schalterHaeltAn('embedding', 'embedding-nachtrag')) !== null;
}
