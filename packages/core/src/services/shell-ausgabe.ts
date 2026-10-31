/**
 * MODUL: shell-ausgabe.ts (P22-T243, mit P22-T208)
 * ZWECK: Shell-Ausgabe nie verschlucken, Abrufe nie fluten.
 *   (1) Keine Job-Ausgabe geht verloren: die volle (maskierte) Ausgabe liegt in Teilen in PG, auch ueber 1 MB.
 *   (2) Jede Abrufart (log-Bereich, log-Suche, get, get_stream, exec-tail) ist nach Zeilen UND Bytes gedeckelt und
 *       sagt bei Kappung, wie gross das Ganze ist und wie man gezielt weiterliest. REST und stdio nutzen dieselben Funktionen.
 *
 * ABLAGE: Die bisher ungenutzte Tabelle shell_stream_chunks (FK shell_jobs ON DELETE CASCADE) wird wiederverwendet:
 *   chunk_index = Teilnummer ab 0, line = maskierter Teiltext (Schnitt an Zeilenenden, ueberlange Zeilen werden zerteilt),
 *   bytes (UTF-8), zeilen (Anzahl '\n' im Teil), zeilen_anfang (Zeilennummer des ersten Zeichens), art ('ausgabe'|'ende').
 *   Summen je Job in shell_jobs.ausgabe_* (teile, bytes, zeilen, offen = letzter Teil ohne '\n', ausgelassen_bytes, stand).
 *   ausgabe_stand: laufend | grenze (Grenze erreicht, weitere Ausgabe wird nur gezaehlt) | ende (Ende-Teile kommen)
 *                  | vollstaendig | luecke | unvollstaendig (beim Abschluss gesetzt).
 * GRENZE je Job (Einstellwert max_bytes_je_job): Kopf bis zur Grenze, dann ein sichtbarer Marker mit ausgelassenen Bytes und
 *   Zeilen samt Einstellwert, dann das Ende (ende_reserve_bytes). Nie still.
 * SCHALTER (Regel neue Funktionen): Produkt-Schalter shell_ausgabe_voll (Standard AUS = Altverhalten, nur ausdruecklich);
 *   interner Test-Override intern_schalter 'shell_ausgabe_voll' (modus freigegeben, befristet, nur mit intern-Tool).
 * EINSTELLWERTE: Tabelle shell_ausgabe_einstellungen (projekt > global > Standard), admin shell_ausgabe_einstellungen
 *   (Koordinator/User). Antworten nennen Werte samt Quelle (debug).
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { internToolAktiv } from './intern-tool-aktiv.js';
import { maskiereShellVorSpeichern, maskiereShellAntwort } from './shell-maske.js';
import { aktuellerW1bAkteur, pruefeProfilVerwalter, ProfilVerwaltungFehler, pflichtText } from './agent-profil-verwalter.js';
import type { AusweisAkteur } from './agent-profil-vertrag.js';

export const SHELL_AUSGABE_FUNKTION = 'shell_ausgabe_voll' as const;

/** Code-Standards; wirksam ist der Wert aus shell_ausgabe_einstellungen (projekt > global > Standard). */
export const SHELL_AUSGABE_EINSTELLUNGEN = {
  /** Ablage je Job; darueber Kopf + Marker + Ende. 256 MB. */
  max_bytes_je_job: 268_435_456,
  /** Ende der Ausgabe, das ueber die Grenze hinaus erhalten bleibt. 4 MB. */
  ende_reserve_bytes: 4_194_304,
  /** Zielgroesse eines Teils (JSON-Bytes). */
  teil_bytes: 262_144,
  /** Laufende Jobs: Uebertragung alle N s, sobald der Job abgeloest ist (P22-T208). */
  live_intervall_s: 5,
  log_max_zeilen: 500,
  log_max_bytes: 65_536,
  suche_max_treffer: 200,
  suche_max_bytes: 65_536,
  suche_max_ms: 15_000,
  kontext_max_zeilen: 10,
  zeile_max_zeichen: 2_000,
  anzeige_kopf_zeilen: 20,
  anzeige_ende_zeilen: 40,
  anzeige_max_bytes: 16_384,
  exec_tail_max_zeilen: 200,
  stream_max_zeilen: 500,
} as const;
export type ShellAusgabeEinstellungName = keyof typeof SHELL_AUSGABE_EINSTELLUNGEN;
export type ShellAusgabeWerte = Record<ShellAusgabeEinstellungName, number>;

/** Harte Obergrenze eines Teils (JSON-Bytes): der HTTP-Body des Daemons muss unter dem Fastify-Bodylimit bleiben. */
export const SHELL_AUSGABE_TEIL_HART_BYTES = 700_000;
/** Groesster Wert, den shell_jobs.output weiter als Kopf fuer Altleser bekommt (wie MAX_OUTPUT_BYTES der Queue). */
const KOPF_MAX_ZEICHEN = 1_000_000;

export class ShellAusgabeFehler extends Error {
  constructor(public code: string, public details: Record<string, unknown> = {}) { super(code); }
}

// ── Schalter und Einstellungen ──────────────────────────────────────────────

export interface ShellAusgabeSchalterStand {
  aktiv: boolean; quelle: string; bis: string | null; letzter_fehler: string | null;
}

/** Produkt-Schalter shell_ausgabe_voll; intern-Override nur bei aktivem intern-Tool (befristet). */
export async function shellAusgabeSchalter(project: string | null | undefined): Promise<ShellAusgabeSchalterStand> {
  const s = await leseProfilProduktSchalter(SHELL_AUSGABE_FUNKTION, project ?? null);
  let stand: ShellAusgabeSchalterStand = {
    aktiv: s.aktiv && !s.letzter_fehler, quelle: String(s.quelle), bis: null, letzter_fehler: s.letzter_fehler ?? null,
  };
  if (internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>(
        "SELECT aktiv,bis FROM intern_schalter WHERE name='shell_ausgabe_voll' AND modus='freigegeben' AND (bis IS NULL OR bis>NOW())");
      const z = r.rows[0];
      if (z) stand = { aktiv: z.aktiv, quelle: 'intern', bis: z.bis ? new Date(z.bis).toISOString() : null, letzter_fehler: null };
    } catch { stand.letzter_fehler = 'shell_ausgabe_override_nicht_lesbar'; }
  }
  return stand;
}

export interface ShellAusgabeWert { wert: number; quelle: 'standard' | 'global' | 'projekt'; standard: number; global: number | null; projekt: number | null }
export interface ShellAusgabeStand {
  project: string | null;
  werte: ShellAusgabeWerte;
  einstellungen: Record<ShellAusgabeEinstellungName, ShellAusgabeWert>;
  schalter: ShellAusgabeSchalterStand;
  letzter_fehler: string | null;
}

/** EINE Lesestelle fuer die Einstellwerte (projekt > global > Standard). Lesefehler -> Standard + letzter_fehler. */
export async function leseShellAusgabeEinstellungen(project: string | null | undefined): Promise<ShellAusgabeStand> {
  let fehler: string | null = null;
  let rows: Array<{ ebene: string; name: string; wert: string }> = [];
  try {
    rows = (await getPool().query(
      "SELECT ebene,name,wert::text FROM shell_ausgabe_einstellungen WHERE ebene='global' OR (ebene='projekt' AND project=$1)",
      [project ?? null])).rows;
  } catch { fehler = 'shell_ausgabe_einstellungen_nicht_lesbar'; }
  const werte = {} as ShellAusgabeWerte;
  const einstellungen = {} as ShellAusgabeStand['einstellungen'];
  for (const name of Object.keys(SHELL_AUSGABE_EINSTELLUNGEN) as ShellAusgabeEinstellungName[]) {
    const std = SHELL_AUSGABE_EINSTELLUNGEN[name];
    const g = rows.find((r) => r.name === name && r.ebene === 'global');
    const p = rows.find((r) => r.name === name && r.ebene === 'projekt');
    const z = p ?? g;
    const n = z ? Number(z.wert) : std;
    const gueltig = Number.isSafeInteger(n) && n > 0;
    if (!gueltig) fehler = 'shell_ausgabe_einstellung_ungueltig';
    werte[name] = gueltig ? n : std;
    einstellungen[name] = { wert: werte[name], quelle: gueltig && z ? (p ? 'projekt' : 'global') : 'standard', standard: std,
      global: g ? Number(g.wert) : null, projekt: p ? Number(p.wert) : null };
  }
  return { project: project ?? null, werte, einstellungen, schalter: await shellAusgabeSchalter(project), letzter_fehler: fehler };
}

export const SHELL_AUSGABE_ADMIN_ACTIONS = ['shell_ausgabe_einstellungen'] as const;
export const SHELL_AUSGABE_ADMIN_PARAMETER = {
  shell_ausgabe_werte: { type: 'object', additionalProperties: { type: 'integer', minimum: 1 }, description: 'shell_ausgabe_einstellungen setzen: Grenzen der Shell-Ausgabe (status nennt Namen, Standard und Quelle)' },
  shell_ausgabe_namen: { type: 'array', items: { type: 'string' }, description: 'shell_ausgabe_einstellungen entfernen: Namen auf dieser Ebene zuruecksetzen' },
};

/** admin shell_ausgabe_einstellungen: modus status (Standard) | setzen | entfernen, ebene projekt (Standard) | global. */
export async function fuehreShellAusgabeAdminAus(args: Record<string, unknown>, wer: AusweisAkteur | null = aktuellerW1bAkteur()): Promise<Record<string, unknown>> {
  try {
    const project = typeof args.project === 'string' && args.project ? args.project : null;
    if (!project || !wer) throw new ProfilVerwaltungFehler('recht_fehlt');
    const akteur = await pruefeProfilVerwalter(wer, project);
    const modus = args.modus ?? 'status';
    if (modus !== 'status') {
      if (modus !== 'setzen' && modus !== 'entfernen') throw new ProfilVerwaltungFehler('modus_ungueltig');
      const ebene = args.ebene ?? 'projekt';
      if (ebene !== 'global' && ebene !== 'projekt') throw new ProfilVerwaltungFehler('ebene_ungueltig');
      const grund = pflichtText(args.grund, 'grund_fehlt');
      const roh = args.shell_ausgabe_werte;
      if (modus === 'setzen' && (!roh || typeof roh !== 'object' || Array.isArray(roh))) throw new ProfilVerwaltungFehler('shell_ausgabe_werte_fehlen');
      if (modus === 'entfernen' && (!Array.isArray(args.shell_ausgabe_namen) || !args.shell_ausgabe_namen.length)) throw new ProfilVerwaltungFehler('shell_ausgabe_namen_fehlen');
      const eintraege = modus === 'setzen'
        ? Object.entries(roh as Record<string, unknown>)
        : (args.shell_ausgabe_namen as unknown[]).map((n) => [n, null] as [unknown, null]);
      if (!eintraege.length) throw new ProfilVerwaltungFehler('shell_ausgabe_werte_fehlen');
      for (const [name, v] of eintraege) {
        if (typeof name !== 'string' || !Object.hasOwn(SHELL_AUSGABE_EINSTELLUNGEN, name)) throw new ProfilVerwaltungFehler('shell_ausgabe_name_ungueltig');
        if (modus === 'setzen' && (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1)) throw new ProfilVerwaltungFehler('shell_ausgabe_wert_ungueltig');
        if (modus === 'setzen' && name === 'teil_bytes' && (v as number) > SHELL_AUSGABE_TEIL_HART_BYTES) throw new ProfilVerwaltungFehler('shell_ausgabe_wert_ungueltig');
      }
      const c = await getPool().connect();
      try {
        await c.query('BEGIN');
        await c.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='10s'");
        const ziel = ebene === 'projekt' ? project : null;
        if (modus === 'entfernen') {
          await c.query("DELETE FROM shell_ausgabe_einstellungen WHERE ebene=$1 AND COALESCE(project,'')=COALESCE($2,'') AND name=ANY($3::text[])",
            [ebene, ziel, eintraege.map((e) => e[0])]);
        } else {
          await c.query(
            `INSERT INTO shell_ausgabe_einstellungen(ebene,project,name,wert,grund,gesetzt_von)
             SELECT $1,$2,n,v,$3,$4 FROM unnest($5::text[],$6::bigint[]) AS x(n,v)
             ON CONFLICT(ebene,(COALESCE(project,'')),name) DO UPDATE SET wert=EXCLUDED.wert,grund=EXCLUDED.grund,gesetzt_von=EXCLUDED.gesetzt_von,gesetzt_am=NOW()`,
            [ebene, ziel, grund, akteur.wer, eintraege.map((e) => e[0]), eintraege.map((e) => e[1])]);
        }
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
    }
    return { success: true, action: 'shell_ausgabe_einstellungen', modus, ...await leseShellAusgabeEinstellungen(project) };
  } catch (e) {
    return { success: false, action: 'shell_ausgabe_einstellungen', error: e instanceof ProfilVerwaltungFehler ? e.code : 'shell_ausgabe_einstellungen_speicher_fehler' };
  }
}

// ── Schneiden (gemeinsam fuer Daemon und Core) ───────────────────────────────

/** Groesse eines Teils, wie er im JSON-Body ankommt (ohne Anfuehrungszeichen). */
export function ausgabeJsonBytes(s: string): number {
  return Buffer.byteLength(JSON.stringify(s), 'utf8') - 2;
}

/**
 * Schneidet Text in Teile von hoechstens maxBytes (JSON-Bytes), bevorzugt hinter einem Zeilenende; eine Zeile ohne
 * Zeilenende im ganzen Fenster wird zerteilt (nie ein UTF-16-Surrogatpaar). offenLassen:true (laufender Job) gibt eine
 * unvollstaendige letzte Zeile als rest zurueck, statt sie zu senden.
 */
export function schneideAusgabeTeile(text: string, maxBytes: number, opt: { offenLassen?: boolean } = {}): { teile: string[]; rest: string } {
  const grenze = Math.max(16, Math.min(Math.trunc(maxBytes), SHELL_AUSGABE_TEIL_HART_BYTES));
  const teile: string[] = [];
  const n = text.length;
  let p = 0;
  while (p < n) {
    let ende = Math.min(n, p + grenze);
    let groesse = ausgabeJsonBytes(text.slice(p, ende));
    while (groesse > grenze && ende - p > 1) {
      ende = p + Math.max(1, Math.floor((ende - p) * grenze / groesse * 0.9));
      groesse = ausgabeJsonBytes(text.slice(p, ende));
    }
    if (ende < n && ende - p > 1) {
      const c = text.charCodeAt(ende - 1);
      if (c >= 0xd800 && c <= 0xdbff) ende--;
    }
    const fensterVoll = ende < n;
    const k = text.slice(p, ende).lastIndexOf('\n');
    if (k >= 0 && (fensterVoll || opt.offenLassen)) ende = p + k + 1;
    else if (!fensterVoll && opt.offenLassen) break;
    teile.push(text.slice(p, ende));
    p = ende;
  }
  return { teile, rest: text.slice(p) };
}

function zaehleZeilenumbrueche(s: string): number {
  let n = 0;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

export function formatiereAusgabeBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ── Schreiben ───────────────────────────────────────────────────────────────

export interface ShellAusgabeTeilEingabe {
  folge: number;
  inhalt: string;
  /** 'ende' = Teil nach erreichter Grenze (Ende der Ausgabe); der erste traegt die ausgelassene Menge. */
  art?: 'ausgabe' | 'ende';
  ausgelassen_bytes?: number;
  ausgelassen_zeilen?: number;
}
export interface ShellAusgabeTeilErgebnis {
  gespeichert: boolean;
  doppelt?: boolean;
  grenze_erreicht?: boolean;
  teile: number;
  bytes: number;
  zeilen: number;
  stand: string;
  einstellungen: { teil_bytes: number; live_intervall_s: number; max_bytes_je_job: number; ende_reserve_bytes: number };
}
type JobSummen = {
  project: string; ausgabe_teile: number | null; ausgabe_bytes: string | null; ausgabe_zeilen: string | null;
  ausgabe_offen: boolean | null; ausgabe_stand: string | null; ausgabe_ausgelassen_bytes: string | null;
};

/**
 * Haengt genau einen Teil an (idempotent je folge, Reihenfolge Pflicht). Wer aufruft, hat Job und Eigentum geprueft
 * (Daemon-Route) bzw. ist der Core selbst. Speichert nur maskierten Text.
 */
export async function haengeShellAusgabeTeilAn(jobId: string, teil: ShellAusgabeTeilEingabe, opt: { pruefeSchalter?: boolean; ohneGrenze?: boolean } = {}): Promise<ShellAusgabeTeilErgebnis> {
  if (!Number.isInteger(teil.folge) || teil.folge < 0 || typeof teil.inhalt !== 'string') throw new ShellAusgabeFehler('ausgabe_teil_ungueltig');
  const art = teil.art ?? 'ausgabe';
  if (art !== 'ausgabe' && art !== 'ende') throw new ShellAusgabeFehler('ausgabe_teil_ungueltig');
  if (ausgabeJsonBytes(teil.inhalt) > SHELL_AUSGABE_TEIL_HART_BYTES) throw new ShellAusgabeFehler('ausgabe_teil_zu_gross', { max_bytes: SHELL_AUSGABE_TEIL_HART_BYTES });
  const kopf = (await getPool().query<{ project: string }>('SELECT project FROM shell_jobs WHERE id=$1::uuid', [jobId])).rows[0];
  if (!kopf) throw new ShellAusgabeFehler('job_unbekannt');
  if (opt.pruefeSchalter !== false && !(await shellAusgabeSchalter(kopf.project)).aktiv) throw new ShellAusgabeFehler('shell_ausgabe_funktion_aus');
  const w = (await leseShellAusgabeEinstellungen(kopf.project)).werte;
  const einst = { teil_bytes: w.teil_bytes, live_intervall_s: w.live_intervall_s, max_bytes_je_job: w.max_bytes_je_job, ende_reserve_bytes: w.ende_reserve_bytes };
  let inhalt = (await maskiereShellVorSpeichern(kopf.project, { inhalt: teil.inhalt })).inhalt;
  const db = await getPool().connect();
  try {
    await db.query('BEGIN');
    const j = (await db.query<JobSummen>(
      `SELECT project,ausgabe_teile,ausgabe_bytes::text,ausgabe_zeilen::text,ausgabe_offen,ausgabe_stand,ausgabe_ausgelassen_bytes::text
         FROM shell_jobs WHERE id=$1::uuid FOR UPDATE`, [jobId])).rows[0];
    if (!j) throw new ShellAusgabeFehler('job_unbekannt');
    const teile = j.ausgabe_teile ?? 0;
    const bytes = Number(j.ausgabe_bytes ?? 0);
    const zeilen = Number(j.ausgabe_zeilen ?? 0);
    let stand = j.ausgabe_stand ?? 'laufend';
    const antwort = (gespeichert: boolean, extra: Partial<ShellAusgabeTeilErgebnis> = {}, s = { teile, bytes, zeilen, stand }): ShellAusgabeTeilErgebnis =>
      ({ gespeichert, ...extra, teile: s.teile, bytes: s.bytes, zeilen: s.zeilen, stand: s.stand, einstellungen: einst });
    if (teil.folge < teile) { await db.query('COMMIT'); return antwort(false, { doppelt: true }); }
    if (teil.folge > teile) throw new ShellAusgabeFehler('ausgabe_teil_luecke', { erwartet: teile });
    let ausgelassen = Number(j.ausgabe_ausgelassen_bytes ?? 0);
    if (art === 'ausgabe') {
      if (stand === 'grenze' || stand === 'ende') { await db.query('COMMIT'); return antwort(false, { grenze_erreicht: true }); }
      if (!opt.ohneGrenze && bytes + Buffer.byteLength(inhalt, 'utf8') > w.max_bytes_je_job) {
        await db.query("UPDATE shell_jobs SET ausgabe_stand='grenze',updated_at=NOW() WHERE id=$1::uuid", [jobId]);
        await db.query('COMMIT');
        return antwort(false, { grenze_erreicht: true }, { teile, bytes, zeilen, stand: 'grenze' });
      }
    } else {
      if (bytes > w.max_bytes_je_job + 2 * w.ende_reserve_bytes + SHELL_AUSGABE_TEIL_HART_BYTES) throw new ShellAusgabeFehler('ausgabe_ende_zu_gross');
      if (stand !== 'ende') {
        const ab = Math.max(0, Math.trunc(Number(teil.ausgelassen_bytes ?? 0)));
        const az = Math.max(0, Math.trunc(Number(teil.ausgelassen_zeilen ?? 0)));
        ausgelassen = ab;
        const marker = `[SHELL-AUSGABE GEKAPPT: ${formatiereAusgabeBytes(ab)} (${ab} Bytes, ${az} Zeilen) ausgelassen - Grenze max_bytes_je_job=${w.max_bytes_je_job} Bytes `
          + `je Job erreicht (Einstellwert, admin shell_ausgabe_einstellungen). Es folgt das Ende der Ausgabe; Zeilennummern ab hier sind um ${az} Zeilen verschoben.]\n`;
        inhalt = (j.ausgabe_offen ? '\n' : '') + marker + inhalt;
        stand = 'ende';
      }
    }
    const b = Buffer.byteLength(inhalt, 'utf8');
    const z = zaehleZeilenumbrueche(inhalt);
    await db.query(
      'INSERT INTO shell_stream_chunks(job_id,chunk_index,line,bytes,zeilen,zeilen_anfang,art) VALUES($1::uuid,$2,$3,$4,$5,$6,$7)',
      [jobId, teil.folge, inhalt, b, z, zeilen + 1, art]);
    await db.query(
      `UPDATE shell_jobs SET ausgabe_teile=$2,ausgabe_bytes=$3,ausgabe_zeilen=$4,ausgabe_offen=$5,ausgabe_stand=$6,
              ausgabe_ausgelassen_bytes=$7,updated_at=NOW() WHERE id=$1::uuid`,
      [jobId, teile + 1, bytes + b, zeilen + z, !inhalt.endsWith('\n'), stand, ausgelassen || null]);
    await db.query('COMMIT');
    return antwort(true, {}, { teile: teile + 1, bytes: bytes + b, zeilen: zeilen + z, stand });
  } catch (e) { await db.query('ROLLBACK').catch(() => undefined); throw e; } finally { db.release(); }
}

/**
 * Core-Weg (PG-Daemon alter Bauart, stdio insertCompletedShellJob/completeShellJob mit grossem output): legt einen
 * vollen Text selbst in Teilen ab. Nichts tun, wenn schon Teile da sind (der Daemon hat live uebertragen).
 * Liefert null, wenn der Schalter aus ist.
 */
export async function speichereShellAusgabeText(jobId: string, project: string, text: string): Promise<{ teile: number } | null> {
  if (!(await shellAusgabeSchalter(project)).aktiv) return null;
  const vorhanden = (await getPool().query<{ n: number | null }>('SELECT ausgabe_teile AS n FROM shell_jobs WHERE id=$1::uuid', [jobId])).rows[0];
  if (vorhanden?.n) return { teile: vorhanden.n };
  const w = (await leseShellAusgabeEinstellungen(project)).werte;
  const buf = Buffer.from(text, 'utf8');
  let kopf = text, ende = '', ausBytes = 0, ausZeilen = 0;
  if (buf.length > w.max_bytes_je_job) {
    let kEnde = w.max_bytes_je_job;
    const nl = buf.lastIndexOf(0x0a, kEnde - 1);
    if (nl > 0) kEnde = nl + 1;
    let eStart = Math.max(kEnde, buf.length - w.ende_reserve_bytes);
    const nl2 = buf.indexOf(0x0a, eStart);
    if (nl2 >= 0 && nl2 + 1 < buf.length) eStart = nl2 + 1;
    kopf = buf.subarray(0, kEnde).toString('utf8');
    ende = buf.subarray(eStart).toString('utf8');
    ausBytes = eStart - kEnde;
    for (let i = buf.indexOf(0x0a, kEnde); i >= 0 && i < eStart; i = buf.indexOf(0x0a, i + 1)) ausZeilen++;
  }
  let folge = 0;
  for (const t of schneideAusgabeTeile(kopf, w.teil_bytes).teile) {
    // Der Kopf ist oben schon auf die Grenze geschnitten; Maskierung darf ihn nicht nachtraeglich kappen.
    await haengeShellAusgabeTeilAn(jobId, { folge: folge++, inhalt: t }, { pruefeSchalter: false, ohneGrenze: true });
  }
  let erstes = true;
  for (const t of schneideAusgabeTeile(ende, w.teil_bytes).teile) {
    await haengeShellAusgabeTeilAn(jobId, { folge: folge++, inhalt: t, art: 'ende',
      ...(erstes ? { ausgelassen_bytes: ausBytes, ausgelassen_zeilen: ausZeilen } : {}) }, { pruefeSchalter: false, ohneGrenze: true });
    erstes = false;
  }
  return { teile: folge };
}

export interface ShellAusgabeAbschlussMeta { teile?: number; bytes_gesamt?: number; zeilen_gesamt?: number; fehler?: string }
export interface ShellAusgabeAbschluss { stand: 'vollstaendig' | 'luecke' | 'unvollstaendig' | 'leer'; kopf: string; teile: number; bytes: number; ausgelassen_bytes: number; meldung?: string }

/** Daemon-Meta im Abschluss (Form pruefen, die Route laesst sonst jedes Objekt durch). */
export function istShellAusgabeMeta(v: unknown): v is ShellAusgabeAbschlussMeta {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return ['teile', 'bytes_gesamt', 'zeilen_gesamt'].every((k) => o[k] === undefined || (typeof o[k] === 'number' && Number.isSafeInteger(o[k]) && (o[k] as number) >= 0))
    && (o.fehler === undefined || typeof o.fehler === 'string');
}

/** Prueft Daemon-Meta gegen den Bestand, setzt den Endstand und liefert den Kopf (<= 1 MB) fuer shell_jobs.output. */
export async function schliesseShellAusgabeAb(jobId: string, meta?: ShellAusgabeAbschlussMeta): Promise<ShellAusgabeAbschluss> {
  const pool = getPool();
  const j = (await pool.query<JobSummen>(
    `SELECT project,ausgabe_teile,ausgabe_bytes::text,ausgabe_zeilen::text,ausgabe_offen,ausgabe_stand,ausgabe_ausgelassen_bytes::text
       FROM shell_jobs WHERE id=$1::uuid`, [jobId])).rows[0];
  const teile = j?.ausgabe_teile ?? 0;
  const bytes = Number(j?.ausgabe_bytes ?? 0);
  const ausgelassen = Number(j?.ausgabe_ausgelassen_bytes ?? 0);
  if (!j || !teile) return { stand: meta?.teile ? 'unvollstaendig' : 'leer', kopf: '', teile: 0, bytes: 0, ausgelassen_bytes: 0,
    ...(meta?.teile ? { meldung: `Teiluebertragung unvollstaendig: ${meta.teile} Teile gemeldet, 0 abgelegt.` } : {}) };
  let stand: ShellAusgabeAbschluss['stand'] = 'vollstaendig';
  let meldung: string | undefined;
  if (meta?.fehler || (meta?.teile !== undefined && meta.teile !== teile)) {
    stand = 'unvollstaendig';
    meldung = `Teiluebertragung unvollstaendig: ${meta?.teile ?? '?'} Teile gemeldet, ${teile} abgelegt${meta?.fehler ? ` (${meta.fehler})` : ''}; die lokale Stream-Datei bleibt bis zu 1 h erhalten.`;
  } else if (j.ausgabe_stand === 'grenze' || j.ausgabe_stand === 'ende') {
    stand = 'luecke';
    meldung = `Ausgabe gekappt: ${formatiereAusgabeBytes(ausgelassen)} ausgelassen (Grenze max_bytes_je_job); Kopf und Ende liegen vor, Marker in der Ausgabe.`
      + (j.ausgabe_stand === 'grenze' ? ' Das Ende fehlt (keine Ende-Teile).' : '');
  }
  await pool.query('UPDATE shell_jobs SET ausgabe_stand=$2,updated_at=NOW() WHERE id=$1::uuid', [jobId, stand]);
  let kopf = '';
  for (let ab = 0; kopf.length < KOPF_MAX_ZEICHEN; ab += 4) {
    const r = await pool.query<{ line: string }>(
      'SELECT line FROM shell_stream_chunks WHERE job_id=$1::uuid AND zeilen_anfang IS NOT NULL ORDER BY chunk_index OFFSET $2 LIMIT 4', [jobId, ab]);
    if (!r.rows.length) break;
    for (const row of r.rows) kopf += row.line;
  }
  if (kopf.length > KOPF_MAX_ZEICHEN || bytes > Buffer.byteLength(kopf, 'utf8')) {
    kopf = kopf.slice(0, KOPF_MAX_ZEICHEN - 400)
      + `\n\n[... Anfang der Ausgabe; vollstaendig (${formatiereAusgabeBytes(bytes)}, ${teile} Teile) per shell(log, id) mit from_line/to_line oder query ...]`;
  }
  return { stand, kopf, teile, bytes, ausgelassen_bytes: ausgelassen, ...(meldung ? { meldung } : {}) };
}

// ── Lesen ───────────────────────────────────────────────────────────────────

type AusgabeKopf = JobSummen & {
  id: string; status: string; output: string | null; message: string | null; output_truncated: boolean | null;
};

async function ladeAusgabeKopf(id: string): Promise<AusgabeKopf | null> {
  const r = await getPool().query<AusgabeKopf>(
    `SELECT id,project,status::text AS status,output,message,output_truncated,ausgabe_teile,ausgabe_bytes::text,ausgabe_zeilen::text,
            ausgabe_offen,ausgabe_stand,ausgabe_ausgelassen_bytes::text
       FROM shell_jobs WHERE id=$1::uuid`, [id]);
  return r.rows[0] ?? null;
}

function zeilenAusText(text: string): string[] {
  const all = text.split('\n');
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  return all;
}

function gesamtVon(k: AusgabeKopf): { total_lines: number; total_bytes: number; vollstaendige_zeilen: number; quelle: 'teile' | 'output' } {
  if (k.ausgabe_teile) {
    const z = Number(k.ausgabe_zeilen ?? 0);
    return { total_lines: z + (k.ausgabe_offen ? 1 : 0), total_bytes: Number(k.ausgabe_bytes ?? 0), vollstaendige_zeilen: z, quelle: 'teile' };
  }
  const t = k.output ?? '';
  const n = zeilenAusText(t).length;
  return { total_lines: n, total_bytes: Buffer.byteLength(t, 'utf8'), vollstaendige_zeilen: n, quelle: 'output' };
}

/** Sehr lange Zeilen ohne Umbruch werden beim Lesen ab dieser Laenge nicht weiter gepuffert. */
const LESE_ZEILE_PUFFER_MAX = 1_000_000;

/** Zeilen ab Zeile ab (1-basiert), stueckweise aus den Teilen bzw. aus output. */
async function* zeilenAb(k: AusgabeKopf, ab: number): AsyncGenerator<{ nr: number; text: string }> {
  if (!k.ausgabe_teile) {
    const all = zeilenAusText(k.output ?? '');
    for (let i = Math.max(0, ab - 1); i < all.length; i++) yield { nr: i + 1, text: all[i] };
    return;
  }
  const pool = getPool();
  const start = (await pool.query<{ chunk_index: number }>(
    `SELECT chunk_index FROM shell_stream_chunks WHERE job_id=$1::uuid AND zeilen_anfang IS NOT NULL AND zeilen_anfang + zeilen >= $2
      ORDER BY chunk_index LIMIT 1`, [k.id, ab])).rows[0];
  if (!start) return;
  let idx = start.chunk_index;
  let nr: number | null = null;
  let puffer = '';
  let verworfen = 0;
  for (;;) {
    const r = await pool.query<{ chunk_index: number; line: string; zeilen_anfang: string }>(
      `SELECT chunk_index,line,zeilen_anfang::text FROM shell_stream_chunks
        WHERE job_id=$1::uuid AND chunk_index >= $2 AND zeilen_anfang IS NOT NULL ORDER BY chunk_index LIMIT 8`, [k.id, idx]);
    if (!r.rows.length) break;
    for (const row of r.rows) {
      if (nr === null) nr = Number(row.zeilen_anfang);
      puffer += row.line;
      let s = 0;
      for (let pos = puffer.indexOf('\n', s); pos >= 0; pos = puffer.indexOf('\n', s)) {
        if (nr >= ab) yield { nr, text: verworfen ? puffer.slice(s, pos) + `…[+${verworfen} Zeichen]` : puffer.slice(s, pos) };
        verworfen = 0;
        nr++;
        s = pos + 1;
      }
      puffer = puffer.slice(s);
      if (puffer.length > LESE_ZEILE_PUFFER_MAX) { verworfen += puffer.length - 100_000; puffer = puffer.slice(0, 100_000); }
    }
    idx = r.rows[r.rows.length - 1].chunk_index + 1;
  }
  if (puffer !== '' && nr !== null && nr >= ab) yield { nr, text: verworfen ? puffer + `…[+${verworfen} Zeichen]` : puffer };
}

function kuerzeZeile(t: string, max: number): string {
  if (t.length <= max) return t;
  let s = t.slice(0, max);
  const c = s.charCodeAt(s.length - 1);
  if (c >= 0xd800 && c <= 0xdbff) s = s.slice(0, -1);
  return s + `…[+${t.length - s.length} Zeichen gekuerzt]`;
}

const LAUFEND = new Set(['pending', 'running']);
const HINWEIS_GEZIELT = 'Gezielt abrufen statt blaettern: shell(log, id, query) bzw. regex/filter:"fehler" durchsucht die VOLLE Ausgabe, '
  + 'kontext_zeilen zeigt die Umgebung, from_line/to_line begrenzt den Bereich.';

export interface ShellLogBereich {
  found: boolean; total_lines: number; from_line: number; to_line: number; lines: string[]; maskiert?: number;
  total_bytes?: number; laufend?: boolean; ausgabe_stand?: string | null; gekappt?: 'zeilen' | 'bytes';
  naechster_bereich?: { from_line: number; to_line: number } | null; gekuerzte_zeilen?: number; hinweis?: string;
  grenzen?: { max_zeilen: number; max_bytes: number; zeile_max_zeichen: number };
}

/** log-Bereich (Schalter an). undefined = Schalter aus (Aufrufer nimmt den Altweg), null = Job unbekannt. */
export async function leseShellAusgabeBereich(id: string, fromLine?: number, toLine?: number): Promise<ShellLogBereich | null | undefined> {
  const k = await ladeAusgabeKopf(id);
  if (!k) return null;
  if (!(await shellAusgabeSchalter(k.project)).aktiv) return undefined;
  const w = (await leseShellAusgabeEinstellungen(k.project)).werte;
  const g = gesamtVon(k);
  const from = Math.max(1, Math.trunc(Number.isFinite(fromLine) ? fromLine as number : 1));
  const gewuenscht = Number.isFinite(toLine) ? Math.max(from, Math.trunc(toLine as number)) : from + 99;
  const bis = Math.min(gewuenscht, from + w.log_max_zeilen - 1);
  let gekappt: ShellLogBereich['gekappt'] = gewuenscht > bis && g.total_lines > bis ? 'zeilen' : undefined;
  const lines: string[] = [];
  let bytes = 0, gekuerzt = 0, letzte = from - 1;
  for await (const z of zeilenAb(k, from)) {
    if (z.nr > bis) break;
    const t = kuerzeZeile(z.text, w.zeile_max_zeichen);
    if (t !== z.text) gekuerzt++;
    const b = Buffer.byteLength(t, 'utf8') + 4;
    if (lines.length && bytes + b > w.log_max_bytes) { gekappt = 'bytes'; break; }
    lines.push(t); bytes += b; letzte = z.nr;
  }
  const ende = Math.min(gewuenscht, g.total_lines);
  const zielBis = letzte < ende ? ende : g.total_lines;
  const naechster = letzte < g.total_lines ? { from_line: letzte + 1, to_line: Math.min(zielBis, letzte + w.log_max_zeilen) } : null;
  // Hinweis bei Kappung und beim Standardbereich mit mehr Ausgabe; ein gezielt erfragter, voll gelieferter Bereich braucht keinen.
  const mitHinweis = !!gekappt || (!Number.isFinite(toLine) && letzte < g.total_lines);
  const result: ShellLogBereich = {
    found: true, total_lines: g.total_lines, total_bytes: g.total_bytes, from_line: from, to_line: lines.length ? letzte : from - 1, lines,
    laufend: LAUFEND.has(k.status), ausgabe_stand: k.ausgabe_stand ?? null,
    ...(gekappt ? { gekappt } : {}), naechster_bereich: naechster, ...(gekuerzt ? { gekuerzte_zeilen: gekuerzt } : {}),
    ...(!mitHinweis ? {} : {
      hinweis: `Ausgabe hat ${g.total_lines} Zeilen (${formatiereAusgabeBytes(g.total_bytes)}${LAUFEND.has(k.status) ? ', Job laeuft noch' : ''}); geliefert ${from}-${lines.length ? letzte : from - 1}`
        + (gekappt ? ` (gekappt: hoechstens ${w.log_max_zeilen} Zeilen / ${formatiereAusgabeBytes(w.log_max_bytes)} je Abruf)` : '')
        + (naechster ? `; weiter mit from_line=${naechster.from_line}` : '') + '. ' + HINWEIS_GEZIELT,
      grenzen: { max_zeilen: w.log_max_zeilen, max_bytes: w.log_max_bytes, zeile_max_zeichen: w.zeile_max_zeichen },
    }),
    ...(k.message?.match(/maskiert:\s*(\d+) Werte/) ? { maskiert: Number(k.message.match(/maskiert:\s*(\d+) Werte/)![1]) } : {}),
  };
  return maskiereShellAntwort(k.project, result);
}

/** Feste Filter fuer die Suche (kombinierbar mit query). */
export const SHELL_LOG_FILTER: Record<string, RegExp> = {
  // 'ERR!' (npm) endet auf ein Nicht-Wortzeichen und steht deshalb ausserhalb der Wortgrenzen.
  fehler: /\b(?:error|errors|fehler|failed|failure|fatal|exception|panic|traceback|assertionerror)\b|\bnot ok\b|\berr!|segmentation fault/i,
  warnungen: /\b(?:warn|warning|warnings|warnung|deprecated|deprecation)\b/i,
  fehler_und_warnungen: /\b(?:error|errors|fehler|failed|failure|fatal|exception|panic|traceback|assertionerror|warn|warning|warnings|warnung|deprecated|deprecation)\b|\bnot ok\b|\berr!|segmentation fault/i,
};

export interface ShellLogSucheOptionen {
  regex?: boolean; case_sensitive?: boolean; max_matches?: number;
  kontext_zeilen?: number; filter?: string; from_line?: number; to_line?: number;
}
export interface ShellLogTreffer { line_number: number; content: string; vorher?: string[]; nachher?: string[] }
export interface ShellLogSuche {
  found: boolean; total_lines: number; total_matches: number; matches: ShellLogTreffer[]; truncated: boolean; maskiert?: number;
  total_bytes?: number; laufend?: boolean; ausgabe_stand?: string | null;
  durchsucht?: { von_zeile: number; bis_zeile: number; vollstaendig: boolean; abbruch?: 'zeit' };
  weiter_ab_zeile?: number | null; hinweis?: string; error?: string; message?: string;
  grenzen?: { max_treffer: number; max_bytes: number; kontext_max_zeilen: number; max_ms: number };
}

/** log-Suche ueber den VOLLEN Bestand (Schalter an). undefined = Schalter aus, null = Job unbekannt. */
export async function sucheShellAusgabe(id: string, query: string | undefined, opts: ShellLogSucheOptionen = {}): Promise<ShellLogSuche | null | undefined> {
  const k = await ladeAusgabeKopf(id);
  if (!k) return null;
  if (!(await shellAusgabeSchalter(k.project)).aktiv) return undefined;
  const w = (await leseShellAusgabeEinstellungen(k.project)).werte;
  const g = gesamtVon(k);
  const basis = { found: true, total_lines: g.total_lines, total_bytes: g.total_bytes, total_matches: 0, matches: [] as ShellLogTreffer[], truncated: false };
  const filterRe = opts.filter ? SHELL_LOG_FILTER[opts.filter] : undefined;
  if (opts.filter && !filterRe) return { ...basis, error: 'filter_unbekannt', message: `filter "${opts.filter}" ist unbekannt; erlaubt: ${Object.keys(SHELL_LOG_FILTER).join(', ')}.` };
  if (!query && !filterRe) return { ...basis, error: 'query_fehlt', message: 'log-Suche braucht query (Text/Regex) oder filter.' };
  let test: ((s: string) => boolean) | null = null;
  if (query) {
    if (opts.regex) {
      let re: RegExp;
      try { re = new RegExp(query, opts.case_sensitive ? '' : 'i'); }
      catch (e) { return { ...basis, error: 'regex_ungueltig', message: e instanceof Error ? e.message : String(e) }; }
      test = (s) => re.test(s);
    } else if (opts.case_sensitive) test = (s) => s.includes(query);
    else { const q = query.toLowerCase(); test = (s) => s.toLowerCase().includes(q); }
  }
  const trifft = (s: string): boolean => (!test || test(s)) && (!filterRe || filterRe.test(s));
  const max = Math.max(1, Math.min(Math.trunc(opts.max_matches ?? w.suche_max_treffer), w.suche_max_treffer));
  const kz = Math.max(0, Math.min(Math.trunc(opts.kontext_zeilen ?? 0), w.kontext_max_zeilen));
  const von = Math.max(1, Math.trunc(Number.isFinite(opts.from_line) ? opts.from_line as number : 1));
  const bis = Number.isFinite(opts.to_line) ? Math.max(von, Math.trunc(opts.to_line as number)) : Number.MAX_SAFE_INTEGER;
  const frist = Date.now() + w.suche_max_ms;
  const matches: ShellLogTreffer[] = [];
  const ring: string[] = [];
  let offen: ShellLogTreffer[] = [];
  let total = 0, bytes = 0, voll = false, weiter: number | null = null, letzte = von - 1, zeitAus = false;
  for await (const z of zeilenAb(k, von)) {
    if (z.nr > bis) break;
    letzte = z.nr;
    const t = kuerzeZeile(z.text, w.zeile_max_zeichen);
    if (offen.length) {
      for (const m of offen) {
        const b = Buffer.byteLength(t, 'utf8') + 4;
        if (bytes + b > w.suche_max_bytes) { voll = true; break; }
        m.nachher!.push(t); bytes += b;
      }
      offen = voll ? [] : offen.filter((m) => m.nachher!.length < kz);
    }
    if (trifft(z.text)) {
      total++;
      if (!voll && matches.length < max) {
        const eintrag: ShellLogTreffer = { line_number: z.nr, content: t, ...(kz ? { vorher: [...ring], nachher: [] } : {}) };
        const b = Buffer.byteLength(JSON.stringify(eintrag), 'utf8');
        if (matches.length && bytes + b > w.suche_max_bytes) { voll = true; weiter ??= z.nr; }
        else { matches.push(eintrag); bytes += b; if (kz) offen.push(eintrag); }
      } else weiter ??= z.nr;
    }
    if (kz) { ring.push(t); if (ring.length > kz) ring.shift(); }
    if ((z.nr & 1023) === 0 && Date.now() > frist) { zeitAus = true; break; }
  }
  const zielEnde = Math.min(bis, g.total_lines);
  const vollstaendig = !zeitAus && letzte >= zielEnde;
  const truncated = total > matches.length || !vollstaendig;
  const teile: string[] = [];
  if (total > matches.length) teile.push(`${matches.length} von ${total} Treffern gezeigt (hoechstens ${max} Treffer / ${formatiereAusgabeBytes(w.suche_max_bytes)} je Abruf)`
    + (weiter ? `; weitere ab from_line=${weiter}` : ''));
  if (zeitAus) teile.push(`Zeitbudget ${w.suche_max_ms} ms erreicht, durchsucht bis Zeile ${letzte} von ${g.total_lines}; Rest mit from_line=${letzte + 1} suchen`);
  const result: ShellLogSuche = {
    ...basis, total_matches: total, matches, truncated,
    laufend: LAUFEND.has(k.status), ausgabe_stand: k.ausgabe_stand ?? null,
    durchsucht: { von_zeile: von, bis_zeile: letzte, vollstaendig, ...(zeitAus ? { abbruch: 'zeit' as const } : {}) },
    weiter_ab_zeile: weiter,
    ...(teile.length ? {
      hinweis: teile.join('. ') + '. Enger suchen (genauere query, regex, filter) oder den Bereich mit from_line/to_line eingrenzen; Umgebung eines Treffers mit kontext_zeilen bzw. shell(log, id, from_line, to_line).',
      grenzen: { max_treffer: w.suche_max_treffer, max_bytes: w.suche_max_bytes, kontext_max_zeilen: w.kontext_max_zeilen, max_ms: w.suche_max_ms },
    } : {}),
    ...(k.message?.match(/maskiert:\s*(\d+) Werte/) ? { maskiert: Number(k.message.match(/maskiert:\s*(\d+) Werte/)![1]) } : {}),
  };
  return maskiereShellAntwort(k.project, result);
}

export interface ShellStreamAntwort {
  id: string; status: string; laufend: boolean; neue_zeilen: string[]; von_zeile: number; bis_zeile: number;
  naechste_seit_zeile: number; total_lines: number; total_bytes: number; ausgabe_stand: string | null;
  gekappt?: 'zeilen' | 'bytes'; hinweis?: string;
}

/**
 * P22-T208 get_stream: neue Zeilen eines (auch laufenden) Jobs ab seit_zeile (Cursor), sonst die letzten tail_lines.
 * Laufend werden nur vollstaendige Zeilen geliefert. undefined = Schalter aus, null = Job unbekannt.
 */
export async function leseShellAusgabeNeu(id: string, opts: { seit_zeile?: number; tail_lines?: number } = {}): Promise<ShellStreamAntwort | null | undefined> {
  const k = await ladeAusgabeKopf(id);
  if (!k) return null;
  if (!(await shellAusgabeSchalter(k.project)).aktiv) return undefined;
  const w = (await leseShellAusgabeEinstellungen(k.project)).werte;
  const g = gesamtVon(k);
  const laufend = LAUFEND.has(k.status);
  const obergrenze = laufend ? g.vollstaendige_zeilen : g.total_lines;
  const tail = Math.max(1, Math.min(Math.trunc(opts.tail_lines ?? 20), w.stream_max_zeilen));
  const von = Number.isFinite(opts.seit_zeile) ? Math.max(1, Math.trunc(opts.seit_zeile as number)) : Math.max(1, obergrenze - tail + 1);
  const bis = Math.min(obergrenze, von + w.stream_max_zeilen - 1);
  let gekappt: ShellStreamAntwort['gekappt'] = obergrenze > bis ? 'zeilen' : undefined;
  const zeilen: string[] = [];
  let bytes = 0, letzte = von - 1;
  if (bis >= von) {
    for await (const z of zeilenAb(k, von)) {
      if (z.nr > bis) break;
      const t = kuerzeZeile(z.text, w.zeile_max_zeichen);
      const b = Buffer.byteLength(t, 'utf8') + 4;
      if (zeilen.length && bytes + b > w.log_max_bytes) { gekappt = 'bytes'; break; }
      zeilen.push(t); bytes += b; letzte = z.nr;
    }
  }
  let hinweis: string | undefined;
  if (laufend && !k.ausgabe_teile) {
    hinweis = `Noch keine Live-Ausgabe in PG: die Uebertragung beginnt, sobald der Job abgeloest ist (~20 s), danach alle ${w.live_intervall_s} s `
      + '(Daemon mit P22-T243-Stand). Bis dahin ist nichts verloren - die volle Ausgabe kommt spaetestens mit dem Abschluss.';
  } else if (gekappt) {
    hinweis = `Gekappt (hoechstens ${w.stream_max_zeilen} Zeilen / ${formatiereAusgabeBytes(w.log_max_bytes)} je Abruf); weiter mit seit_zeile=${letzte + 1}. ` + HINWEIS_GEZIELT;
  }
  const result: ShellStreamAntwort = {
    id: k.id, status: k.status, laufend, neue_zeilen: zeilen, von_zeile: von, bis_zeile: letzte,
    naechste_seit_zeile: letzte + 1, total_lines: obergrenze, total_bytes: g.total_bytes, ausgabe_stand: k.ausgabe_stand ?? null,
    ...(gekappt ? { gekappt } : {}), ...(hinweis ? { hinweis } : {}),
  };
  return maskiereShellAntwort(k.project, result);
}

export interface ShellAusgabeAnzeige {
  total_lines: number; total_bytes: number; laufend: boolean; stand: string | null;
  kopf: string[]; ende: string[]; ausgelassen?: { von_zeile: number; bis_zeile: number }; hinweis: string;
}

/**
 * shell(get): statt output am Stueck nur Kopf + Ende + Gesamtgroesse + Verweis auf log. null = nichts zu tun
 * (Schalter aus oder Ausgabe klein genug). Erwartet eine bereits maskierte Job-Zeile.
 */
export async function shellAusgabeAnzeige(job: { id: string; project: string; status: string; output?: string | null } & Partial<JobSummen>): Promise<ShellAusgabeAnzeige | null> {
  if (!(await shellAusgabeSchalter(job.project)).aktiv) return null;
  const w = (await leseShellAusgabeEinstellungen(job.project)).werte;
  const k: AusgabeKopf = {
    id: job.id, project: job.project, status: String(job.status), output: job.output ?? null, message: null, output_truncated: null,
    ausgabe_teile: job.ausgabe_teile ?? null, ausgabe_bytes: job.ausgabe_bytes != null ? String(job.ausgabe_bytes) : null,
    ausgabe_zeilen: job.ausgabe_zeilen != null ? String(job.ausgabe_zeilen) : null, ausgabe_offen: job.ausgabe_offen ?? null,
    ausgabe_stand: job.ausgabe_stand ?? null, ausgabe_ausgelassen_bytes: null,
  };
  const g = gesamtVon(k);
  const laufend = LAUFEND.has(k.status);
  if (!k.ausgabe_teile && g.total_bytes <= w.anzeige_max_bytes && g.total_lines <= w.anzeige_kopf_zeilen + w.anzeige_ende_zeilen) return null;
  const budget = Math.floor(w.anzeige_max_bytes / 2);
  const zeileMax = Math.min(w.zeile_max_zeichen, 500);
  const kopf: string[] = [];
  let bytes = 0, letzteKopf = 0;
  for await (const z of zeilenAb(k, 1)) {
    if (z.nr > w.anzeige_kopf_zeilen) break;
    const t = kuerzeZeile(z.text, zeileMax);
    const b = Buffer.byteLength(t, 'utf8') + 4;
    if (kopf.length && bytes + b > budget) break;
    kopf.push(t); bytes += b; letzteKopf = z.nr;
  }
  const obergrenze = laufend && k.ausgabe_teile ? g.vollstaendige_zeilen : g.total_lines;
  const endeAb = Math.max(letzteKopf + 1, obergrenze - w.anzeige_ende_zeilen + 1);
  const ende: string[] = [];
  let endeBytes = 0, ersteEnde = endeAb;
  if (endeAb <= obergrenze) {
    const sammlung: Array<{ nr: number; t: string }> = [];
    for await (const z of zeilenAb(k, endeAb)) {
      if (z.nr > obergrenze) break;
      sammlung.push({ nr: z.nr, t: kuerzeZeile(z.text, zeileMax) });
    }
    for (let i = sammlung.length - 1; i >= 0; i--) {
      const b = Buffer.byteLength(sammlung[i].t, 'utf8') + 4;
      if (ende.length && endeBytes + b > budget) break;
      ende.unshift(sammlung[i].t); endeBytes += b; ersteEnde = sammlung[i].nr;
    }
  }
  const luecke = ende.length ? ersteEnde - letzteKopf - 1 : obergrenze - letzteKopf;
  return {
    total_lines: g.total_lines, total_bytes: g.total_bytes, laufend, stand: k.ausgabe_stand ?? null, kopf, ende,
    ...(luecke > 0 ? { ausgelassen: { von_zeile: letzteKopf + 1, bis_zeile: letzteKopf + luecke } } : {}),
    hinweis: `Ausgabe gekuerzt angezeigt: ${g.total_lines} Zeilen (${formatiereAusgabeBytes(g.total_bytes)})${laufend ? ', Job laeuft noch' : ''}; kopf = Zeilen 1-${letzteKopf}`
      + (ende.length ? `, ende = Zeilen ${ersteEnde}-${ersteEnde + ende.length - 1}` : '') + '. Volle Ausgabe: shell(log, id, from_line/to_line) bzw. '
      + 'shell(log, id, query|filter); laufende Jobs: shell(get_stream, id, seit_zeile).',
  };
}

/** exec-Antwort: tail nach Zeilen und Bytes deckeln (Schalter an). */
export async function begrenzeShellTail(project: string | undefined, tail: unknown): Promise<{ tail: unknown; tail_gekappt?: { zeilen: number; hinweis: string } }> {
  if (!project || !Array.isArray(tail) || !(await shellAusgabeSchalter(project)).aktiv) return { tail };
  const w = (await leseShellAusgabeEinstellungen(project)).werte;
  const roh = tail.slice(-w.exec_tail_max_zeilen).map((z) => String(z));
  const quelle = roh.map((z) => kuerzeZeile(z, w.zeile_max_zeichen));
  const aus: string[] = [];
  let bytes = 0;
  for (let i = quelle.length - 1; i >= 0; i--) {
    const b = Buffer.byteLength(quelle[i], 'utf8') + 4;
    if (aus.length && bytes + b > w.anzeige_max_bytes) break;
    aus.unshift(quelle[i]); bytes += b;
  }
  const weg = tail.length - aus.length;
  const gekuerzt = quelle.some((z, i) => z !== roh[i]);
  return weg > 0 || gekuerzt
    ? { tail: aus, tail_gekappt: { zeilen: weg, hinweis: `tail gekappt (hoechstens ${w.exec_tail_max_zeilen} Zeilen / ${formatiereAusgabeBytes(w.anzeige_max_bytes)}, lange Zeilen gekuerzt); volle Ausgabe per shell(log, id).` } }
    : { tail: aus };
}

/** tail_lines fuer neue Jobs deckeln (Schalter an), damit auch der gespeicherte tail klein bleibt. */
export async function begrenzeShellTailLines(project: string, n: number | undefined): Promise<number | undefined> {
  if (n === undefined || !(await shellAusgabeSchalter(project)).aktiv) return n;
  const w = (await leseShellAusgabeEinstellungen(project)).werte;
  return Math.max(1, Math.min(Math.trunc(n), w.exec_tail_max_zeilen));
}
