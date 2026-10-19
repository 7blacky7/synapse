/**
 * P22-T13 Phase V: Schalter fuer W1b (regel-neue-funktionen-mit-schalter-und-debug).
 *
 * (I) PRODUKT-SCHALTER agent_profil_schalter (PG, Schema 113). Standard AUS = keine Zeile.
 *     Steuert die Verwaltungsfunktionen der Pakete A/B/D/T (PROFIL_PRODUKT_FUNKTIONEN).
 *     Setzen: User (authentifizierter User-Eingang) global/projekt, bestaetigter Koordinator nur
 *     fuer sein eigenes Projekt. Vorrang: projekt+funktion > projekt+alle > global+funktion >
 *     global+alle > Standard AUS. Lesefehler (z. B. vor Schema 113) -> AUS mit letzter_fehler.
 *     Gelesen wird NUR in Verwaltungspfaden, nie pro gewoehnlichem Tool-Aufruf.
 * (II) INTERNE TEST-OVERRIDES w1b_durchsetzung (Token-Selbstfeldpruefung F3, Neutralisierung der
 *     REST-Vorbelegung, Profil-Gate) und w1b_antwortanpassung (Paket C). Produktionsstandard per
 *     Env SYNAPSE_W1B_DURCHSETZUNG / SYNAPSE_W1B_ANTWORTANPASSUNG ('1' = EIN), Default AUS.
 *     Override nur bei SYNAPSE_INTERN_TOOL=1, modus 'freigegeben', befristet (intern-schalter.ts);
 *     Ablauf/Lesefehler/ohne intern -> Produktionsstandard. Ohne intern KEIN PG-Lesen.
 * AUS = t109-Verhalten. Bedeutung 'freigegeben' (aktiv=true heisst Funktion EIN, keine Pause).
 */
import { getPool } from '../db/client.js';
import { internToolAktiv } from './intern-tool.js';

export type W1bSchalterArt = 'durchsetzung' | 'antwortanpassung' | 'anmeldung';
export const W1B_INTERN_SCHALTER = {
  durchsetzung: 'w1b_durchsetzung',
  antwortanpassung: 'w1b_antwortanpassung',
  anmeldung: 'w1b_anmeldung',
} as const satisfies Record<W1bSchalterArt, string>;
const W1B_ENV: Record<W1bSchalterArt, string> = {
  durchsetzung: 'SYNAPSE_W1B_DURCHSETZUNG',
  antwortanpassung: 'SYNAPSE_W1B_ANTWORTANPASSUNG',
  anmeldung: 'SYNAPSE_W1B_ANMELDUNG',
};

export interface W1bSchalterStand {
  art: W1bSchalterArt;
  name: string;
  freigegeben: boolean;
  standard: boolean;
  quelle: 'standard' | 'intern';
  bis: string | null;
  letzter_fehler: string | null;
}

/** Frisch je Aufruf (kein Cache, damit ein abgelaufener/geloeschter Override sofort wegfaellt). */
export async function leseW1bSchalter(art: W1bSchalterArt): Promise<W1bSchalterStand> {
  const standard = process.env[W1B_ENV[art]] === '1';
  const basis: W1bSchalterStand = { art, name: W1B_INTERN_SCHALTER[art], freigegeben: standard, standard,
    quelle: 'standard', bis: null, letzter_fehler: null };
  if (!internToolAktiv()) return basis;
  try {
    const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
      text: `SELECT aktiv, bis FROM intern_schalter
        WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
      values: [W1B_INTERN_SCHALTER[art]],
      query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    const z = r.rows[0];
    return z ? { ...basis, freigegeben: z.aktiv, quelle: 'intern', bis: z.bis?.toISOString() ?? null } : basis;
  } catch {
    return { ...basis, letzter_fehler: 'schalter_nicht_erreichbar' };
  }
}

export const PROFIL_PRODUKT_FUNKTIONEN = [
  'profilverwaltung', 'typkatalog', 'persona', 'task_bindung', 'agenten_ausweis',
] as const;
/**
 * W12 V7: 'schattenprofile' und 'token_abruf' sind im Produkt-Schalter 'agenten_ausweis' aufgegangen. Die alten Namen
 * bleiben nur LESBAR/setzbar (Altschalter-Rueckfall des Ausweis-Kerns, bestehende Zeilen), sind aber nicht mehr im Katalog.
 */
export const ALT_AUSWEIS_FUNKTIONEN = ['schattenprofile', 'token_abruf'] as const;
export type ProfilProduktFunktion = typeof PROFIL_PRODUKT_FUNKTIONEN[number] | typeof ALT_AUSWEIS_FUNKTIONEN[number];

// ---------------------------------------------------------------------------------------------
// W12 S1 (Vertrag P22-T23, V7): Ausweis-Kern. Die SIGNATUR ist verbindlich und der einzige Lesepunkt fuer
// Ausweis-Pfade. P22-T28: EIN Produkt-Schalter 'agenten_ausweis' ersetzt token_identitaet + w1b_anmeldung +
// schattenprofile + token_abruf. Reihenfolge der Quellen:
//   Vorrang intern-Override 'agenten_ausweis' (nur SYNAPSE_INTERN_TOOL=1, befristet) > Produkt-Schalter
//   'agenten_ausweis' (projekt > global; PG = Quelle fuer alle Prozesse) > Altschalter > AUS.
//   Immer: agent_bezug_modus muss 'beide' sein, sonst wirksam AUS (letzter_fehler agent_bezug_modus_nicht_beide).
//   Dazwischen: Env SYNAPSE_AGENTEN_AUSWEIS=1 (Produktionsstandard, quelle 'standard') und die Altschalter
//   (Env/intern token_identitaet + w1b_anmeldung + Produkt-Schalter schattenprofile) als Rueckfall. Einschalten des Produkt-
//   Schalters ist nur bei agent_bezug_modus 'beide' moeglich (Fehler agent_bezug_modus_nicht_beide).
// PG = Quelle: der Stand wird je Prozess kurz gepuffert (Env SYNAPSE_W1B_GATE_TTL_MS, Standard 5000, 0 = aus). Das Schreiben
//   eines Produkt-Schalters leert den Puffer im SCHREIBENDEN Prozess sofort, andere Prozesse sehen es nach ihrer TTL.
// Befund B4: profilverwaltung AUS sperrt nur die VERWALTUNG (profil_aendern, Typen, Rollback ...). Ein bereits gesetzter
//   Zuschnitt (Werkzeugsperren im Profil) bleibt wirksam, solange w1b_durchsetzung EIN ist; er wird nicht zurueckgenommen.
//   Zum Zuruecknehmen vorher per profil_aendern/profil_rollback aendern oder w1b_durchsetzung AUS schalten.
// Alle Ausweis-Lesestellen (Identitaet, Tool-Gate, tools/list, Daemon-Start, Hinweis-Registry, Schatten-Dienste) lesen nur hier.
// ---------------------------------------------------------------------------------------------
export const AUSWEIS_KERN_FUNKTION = 'agenten_ausweis' as const;
export type AusweisKernQuelle = 'standard' | 'intern' | 'produkt-schalter' | 'altschalter';
export interface AusweisKernStand {
  aktiv: boolean;
  project: string | null;
  quelle: AusweisKernQuelle;
  agent_bezug_modus: 'alt' | 'beide' | 'neu' | null;
  letzter_fehler: string | null;
}

const KERN_PUFFER = new Map<string, { bis: number; stand: ProfilProduktSchalterStand }>();
/** Puffer verwerfen (Tests; automatisch nach jedem Schreiben eines Produkt-Schalters im eigenen Prozess). */
export function leereAusweisKernCache(): void { KERN_PUFFER.clear(); }
function kernTtlMs(): number {
  const roh = process.env.SYNAPSE_W1B_GATE_TTL_MS;
  if (roh === undefined || roh.trim() === '') return 5_000;
  const n = Number(roh);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5_000;
}
async function leseProduktGepuffert(funktion: ProfilProduktFunktion, project: string | null): Promise<ProfilProduktSchalterStand> {
  const ttl = kernTtlMs();
  const schluessel = funktion + '\u0000' + (project ?? '');
  const jetzt = Date.now();
  const c = ttl > 0 ? KERN_PUFFER.get(schluessel) : undefined;
  if (c && c.bis > jetzt) return c.stand;
  const stand = await leseProfilProduktSchalter(funktion, project);
  if (ttl > 0 && !stand.letzter_fehler) KERN_PUFFER.set(schluessel, { bis: jetzt + ttl, stand });
  return stand;
}

interface KernRoh { aktiv: boolean; quelle: AusweisKernQuelle; fehler: string | null }
async function ausweisKernRoh(p: string | null): Promise<KernRoh> {
  let fehler: string | null = null;
  // 1. intern-Override (nur SYNAPSE_INTERN_TOOL=1, befristet; Ablauf/Lesefehler -> Produktionsstandard)
  if (internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean }>({
        text: `SELECT aktiv FROM intern_schalter
          WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
        values: [AUSWEIS_KERN_FUNKTION],
        query_timeout: 2000,
      } as import('pg').QueryConfig & { query_timeout: number });
      if (r.rows[0]) return { aktiv: r.rows[0].aktiv, quelle: 'intern', fehler };
    } catch { fehler = 'schalter_nicht_erreichbar'; }
  }
  // 2. Produkt-Schalter (projekt > global; PG = Quelle fuer alle Prozesse)
  const prod = await leseProduktGepuffert(AUSWEIS_KERN_FUNKTION, p);
  if (prod.letzter_fehler) fehler = fehler ?? prod.letzter_fehler;
  else if (prod.quelle === 'produkt-schalter') return { aktiv: prod.aktiv, quelle: 'produkt-schalter', fehler };
  // 3. Produktionsstandard per Env
  if (process.env.SYNAPSE_AGENTEN_AUSWEIS === '1') return { aktiv: true, quelle: 'standard', fehler };
  // 4. Altschalter (Rueckfall)
  const { leseTokenIdentitaetSchalter } = await import('./agent-identitaet.js');
  const alt = (await leseTokenIdentitaetSchalter()).freigegeben && (await leseW1bSchalter('anmeldung')).freigegeben
    && (p === null || (await leseProduktGepuffert('schattenprofile', p)).aktiv);
  return { aktiv: alt, quelle: alt ? 'altschalter' : 'standard', fehler };
}

export async function leseAusweisKern(project?: string | null): Promise<AusweisKernStand> {
  const p = project ?? null;
  const basis: AusweisKernStand = { aktiv: false, project: p, quelle: 'standard', agent_bezug_modus: null, letzter_fehler: null };
  try {
    // Dynamisch: agent-bezug/agent-identitaet importieren (indirekt) diese Datei.
    const { leseAgentBezugModus } = await import('./agent-bezug.js');
    const modus = (await leseAgentBezugModus()).modus as AusweisKernStand['agent_bezug_modus'];
    const roh = await ausweisKernRoh(p);
    const stand: AusweisKernStand = { ...basis, agent_bezug_modus: modus, quelle: roh.quelle, letzter_fehler: roh.fehler };
    if (!roh.aktiv) return stand;
    if (modus !== 'beide') return { ...stand, letzter_fehler: 'agent_bezug_modus_nicht_beide' };
    return { ...stand, aktiv: true };
  } catch {
    return { ...basis, letzter_fehler: 'ausweis_kern_nicht_lesbar' };
  }
}

/**
 * Wie leseAusweisKern, aber ohne bekanntes Projekt (Aufruf nur mit Ausweis): ist der Kern global/ohne Projekt AUS, wird das
 * Projekt aus dem Ausweis ermittelt und dessen Projekt-Stand gelesen. Der Ausweiswert geht nur als Abfrageparameter in PG.
 */
export async function leseAusweisKernFuerToken(token: string | undefined, project?: string | null): Promise<AusweisKernStand> {
  const k = await leseAusweisKern(project ?? null);
  if (k.aktiv || project || typeof token !== 'string' || !/^sai_[a-f0-9]{64}$/.test(token)) return k;
  try {
    const r = await getPool().query<{ project: string }>({
      text: `SELECT i.project FROM agent_identitaet_tokens t JOIN agent_identitaeten i ON i.id = t.identity_id
        WHERE t.token_offen = $1 AND t.widerrufen_am IS NULL LIMIT 1`,
      values: [token],
      query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    return r.rows[0] ? await leseAusweisKern(r.rows[0].project) : k;
  } catch {
    return k;
  }
}

// ---------------------------------------------------------------------------------------------
// Lesestellen der BESTANDSPFADE (Identitaet, Tool-Gate, tools/list, Daemon-Start, Anmeldung, Schatten-Dienste).
// Wirksam = Ausweis-Kern (Produkt-Schalter agenten_ausweis / intern / Env, nur bei agent_bezug_modus 'beide')
// ODER der alte Einzelschalter als Produktionsstandard/Test-Override (Env/intern token_identitaet, w1b_anmeldung,
// Produkt-Schalter schattenprofile) in jedem Modus. So bleibt das Verhalten der Vorstufe (t110) bei allen alten
// Schaltern unveraendert; der neue EINE Schalter schaltet alles zusammen, aber nur bei 'beide'.
// ---------------------------------------------------------------------------------------------
async function leseAltTokenIdentitaet(): Promise<boolean> {
  const { leseTokenIdentitaetSchalter } = await import('./agent-identitaet.js');
  return (await leseTokenIdentitaetSchalter()).freigegeben;
}
/** Token-Identitaet (Ausweispruefung, token-Parameter, Daemon-Start). */
export async function ausweisTokenAktiv(project?: string | null, token?: string): Promise<boolean> {
  if ((await leseAusweisKernFuerToken(token, project ?? null)).aktiv) return true;
  return leseAltTokenIdentitaet();
}
/** Anmeldung (koordinator_liste, Herkunftsort, Hinweisquellen, Schattenprofil bei Legacy-Anmeldung braucht zusaetzlich ausweisSchattenAktiv). */
export async function ausweisAnmeldungAktiv(project?: string | null): Promise<boolean> {
  if ((await leseAusweisKern(project ?? null)).aktiv) return true;
  return (await leseW1bSchalter('anmeldung')).freigegeben && await leseAltTokenIdentitaet();
}
/** Schattenprofile des Projekts (Kern oder alt: Anmeldung EIN + Produkt-Schalter schattenprofile). Lesefehler = AUS. */
export async function ausweisSchattenAktiv(project: string, mitAnmeldung = true): Promise<boolean> {
  if ((await leseAusweisKern(project)).aktiv) return true;
  // mitAnmeldung=false: Schatten-DIENSTE (Anlage/Verwaltung) wie bisher nur am Produkt-Schalter; true: Anmeldungs-Gate zusaetzlich.
  if (mitAnmeldung && !(await ausweisAnmeldungAktiv(null))) return false;
  const s = await leseProduktGepuffert('schattenprofile', project);
  return s.aktiv && !s.letzter_fehler;
}

export interface ProfilProduktSchalterStand {
  funktion: ProfilProduktFunktion;
  project: string | null;
  aktiv: boolean;
  quelle: 'standard' | 'produkt-schalter';
  ebene: 'global' | 'projekt' | null;
  regel_funktion: ProfilProduktFunktion | 'alle' | null;
  gesetzt_von: string | null;
  gesetzt_am: string | null;
  grund: string | null;
  letzter_fehler: string | null;
}

export class ProfilSchalterFehler extends Error {
  constructor(public readonly code: string) { super(code); }
}

interface SchalterZeile {
  ebene: 'global' | 'projekt'; project: string | null; funktion: string; aktiv: boolean;
  grund: string | null; gesetzt_von: string; gesetzt_am: Date;
}

function istFunktion(f: string): f is ProfilProduktFunktion {
  return (PROFIL_PRODUKT_FUNKTIONEN as readonly string[]).includes(f) || (ALT_AUSWEIS_FUNKTIONEN as readonly string[]).includes(f);
}

export async function leseProfilProduktSchalter(
  funktion: ProfilProduktFunktion, project?: string | null,
): Promise<ProfilProduktSchalterStand> {
  const basis: ProfilProduktSchalterStand = { funktion, project: project ?? null, aktiv: false, quelle: 'standard',
    ebene: null, regel_funktion: null, gesetzt_von: null, gesetzt_am: null, grund: null, letzter_fehler: null };
  if (!istFunktion(funktion)) return { ...basis, letzter_fehler: 'funktion_unbekannt' };
  try {
    const r = await getPool().query<SchalterZeile>({
      text: `SELECT ebene, project, funktion, aktiv, grund, gesetzt_von, gesetzt_am FROM agent_profil_schalter
        WHERE funktion = ANY($1::text[]) AND (ebene = 'global' OR (ebene = 'projekt' AND project = $2))`,
      values: [[funktion, 'alle'], project ?? null],
      query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    const rang = (z: SchalterZeile) => (z.ebene === 'projekt' ? 2 : 0) + (z.funktion === funktion ? 1 : 0);
    const z = [...r.rows].sort((a, b) => rang(b) - rang(a))[0];
    if (!z) return basis;
    return { ...basis, aktiv: z.aktiv, quelle: 'produkt-schalter', ebene: z.ebene,
      regel_funktion: z.funktion as ProfilProduktFunktion | 'alle', gesetzt_von: z.gesetzt_von,
      gesetzt_am: z.gesetzt_am.toISOString(), grund: z.grund };
  } catch {
    return { ...basis, letzter_fehler: 'produkt_schalter_nicht_lesbar' };
  }
}

/** Akteur kommt ausschliesslich aus authentifiziertem Transport bzw. Tokenpruefung, nie aus Tool-Argumenten. */
export interface ProfilSchalterAkteur {
  system?: 'user';
  identity_id?: string;
}

/**
 * P22-T29 (Befund 26cf1837 B1): Prozess-lokale Puffer (z. B. Anmelde-Gate-Cache) melden sich hier an und werden
 * nach jedem erfolgreichen Schreiben eines Produkt-Schalters im SCHREIBENDEN Prozess verworfen. Andere Prozesse
 * sehen die Aenderung nach ihrer eigenen TTL. Reine Fehlerkorrektur, kein Schalter. Hook-Fehler werden verschluckt.
 */
const schalterGeschriebenHooks = new Set<() => void>();
export function registriereSchalterGeschrieben(hook: () => void): void { schalterGeschriebenHooks.add(hook); }

export async function setzeProfilProduktSchalter(
  e: { ebene: 'global' | 'projekt'; project?: string | null; funktion: ProfilProduktFunktion | 'alle'; aktiv: boolean; grund: string },
  akteur: ProfilSchalterAkteur,
): Promise<ProfilProduktSchalterStand> {
  if (e.funktion !== 'alle' && !istFunktion(e.funktion)) throw new ProfilSchalterFehler('funktion_unbekannt');
  if (e.ebene !== 'global' && e.ebene !== 'projekt') throw new ProfilSchalterFehler('ebene_ungueltig');
  const project = e.ebene === 'projekt' ? (e.project ?? '').trim() : null;
  if (e.ebene === 'projekt' && !project) throw new ProfilSchalterFehler('project_fehlt');
  if (typeof e.grund !== 'string' || e.grund.trim().length < 5) throw new ProfilSchalterFehler('grund_fehlt');
  if (typeof e.aktiv !== 'boolean') throw new ProfilSchalterFehler('aktiv_fehlt');
  // W12 V7: der Ausweis-Kern darf nur bei agent_bezug_modus 'beide' eingeschaltet werden.
  // P22-T31: 'alle' mit aktiv:true schaltet den Ausweis-Kern mit ein und unterliegt derselben Modus-Pruefung.
  if ((e.funktion === AUSWEIS_KERN_FUNKTION || e.funktion === 'alle') && e.aktiv) {
    const { leseAgentBezugModus } = await import('./agent-bezug.js');
    if ((await leseAgentBezugModus()).modus !== 'beide') throw new ProfilSchalterFehler('agent_bezug_modus_nicht_beide');
  }
  let wer: string;
  let setter: string | null = null;
  if (akteur.system === 'user') {
    wer = 'user';
  } else if (akteur.identity_id && e.ebene === 'projekt') {
    const r = await getPool().query(
      "SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2 AND status='aktiv' AND rolle='koordinator'",
      [akteur.identity_id, project]);
    if (!r.rows.length) throw new ProfilSchalterFehler('recht_fehlt');
    wer = akteur.identity_id;
    setter = akteur.identity_id;
  } else {
    throw new ProfilSchalterFehler('recht_fehlt');
  }
  await getPool().query(
    `INSERT INTO agent_profil_schalter (ebene, project, funktion, aktiv, grund, gesetzt_von, setter_identity_id, gesetzt_am)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (ebene, (COALESCE(project, '')), funktion) DO UPDATE SET aktiv=EXCLUDED.aktiv, grund=EXCLUDED.grund,
       gesetzt_von=EXCLUDED.gesetzt_von, setter_identity_id=EXCLUDED.setter_identity_id, gesetzt_am=EXCLUDED.gesetzt_am`,
    [e.ebene, project, e.funktion, e.aktiv, e.grund.trim(), wer, setter]);
  for (const hook of schalterGeschriebenHooks) { try { hook(); } catch { /* Puffer-Invalidierung darf das Schreiben nie scheitern lassen */ } }
  return leseProfilProduktSchalter(e.funktion === 'alle' ? 'profilverwaltung' : e.funktion, project);
}
// Eigener Prozess: Kern-Puffer nach jedem Schreiben verwerfen (nach der Hook-Menge definiert, daher am Dateiende).
registriereSchalterGeschrieben(leereAusweisKernCache);
