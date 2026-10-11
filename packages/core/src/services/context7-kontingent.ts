/**
 * MODUL: Context7-Kontingent
 * ZWECK: Zaehlt JEDEN Context7-Aufruf (Automatik, Such-Auto-Fetch, sonstige) gegen ein Monatsbudget
 *        und eine Tagesgrenze in PG und entscheidet nach Restbudget, welche Art von Aufruf noch
 *        erlaubt ist. Der Context7-Client ruft reserviereContext7Aufruf() VOR jedem HTTP-Aufruf
 *        (P12-T17, User-Vorgabe 11.10.2026). Context7 zaehlt API-AUFRUFE, nicht Tokens
 *        (Free-Plan ~1000/Monat) — gespart wird an der ZAHL der Aufrufe, nie am Umfang.
 *
 * STUFEN nach Restbudget (Schwellen per Env, Prozent des Monatsbudgets):
 *   Rest > SYNAPSE_CONTEXT7_STUFE_VOLL (50)   'voll'       alles: neue Bibliotheken, Update-Checks, Suche
 *   Rest > SYNAPSE_CONTEXT7_STUFE_NEU (20)    'nur_neue'   Automatik nur noch fuer neue Bibliotheken
 *   Rest > SYNAPSE_CONTEXT7_STUFE_SUCHE (5)   'nur_suche'  Automatik aus, nur interaktive Suche
 *   darunter                                  'aus'        Context7 komplett aus bis zum Reset
 *   Aufrufarten: 'update' (Update-Check der Automatik) braucht 'voll', 'neu' (neue Bibliothek)
 *   braucht mindestens 'nur_neue', 'interaktiv' (Suche, Standard) mindestens 'nur_suche'.
 *
 * ENV (alle optional):
 *   SYNAPSE_CONTEXT7_MONATSBUDGET=1000   Aufrufe je Abrechnungsmonat (0 = Context7 aus)
 *   SYNAPSE_CONTEXT7_RESET_TAG=1         Tag im Monat, an dem der Zaehler neu beginnt (1..28)
 *   SYNAPSE_CONTEXT7_STUFE_VOLL=50, SYNAPSE_CONTEXT7_STUFE_NEU=20, SYNAPSE_CONTEXT7_STUFE_SUCHE=5
 *   SYNAPSE_CONTEXT7_MAX_PRO_TAG         Tagesgrenze fuer die AUTOMATIK (Default: Budget/30, aufgerundet);
 *                                        interaktive Aufrufe zaehlen mit, werden aber nicht begrenzt
 *   SYNAPSE_CONTEXT7_QUOTA_PAUSE_H=24    Pause fuer ALLE Aufrufe, nachdem Context7 429/Quota meldet
 *
 * NEBENEFFEKTE:
 *   - PostgreSQL: context7_automatik_stand (genau eine Zeile, id = 1) — Zaehler ueberleben Neustarts
 *   - Logs: Stufenwechsel, Pause
 *
 * ABHAENGIGKEITEN:
 *   - ../db/client.js (intern)
 */

import { getPool } from '../db/client.js';

export type Context7Aufrufart = 'neu' | 'update' | 'interaktiv';
export type Context7Stufe = 'voll' | 'nur_neue' | 'nur_suche' | 'aus';

export interface Context7Kontingent {
  /** Beginn des laufenden Abrechnungsmonats (YYYY-MM-DD). */
  monat: string;
  verbraucht: number;
  budget: number;
  rest_prozent: number;
  stufe: Context7Stufe;
  heute: number;
  tagesgrenze: number;
  pause_bis: Date | null;
  pause_grund: string | null;
}

/** Ergebnis einer Reservierung: ok oder der Grund der Ablehnung. */
export type Context7Reservierung =
  | { ok: true }
  | { ok: false; grund: 'pause' | 'monatsbudget' | 'tagesgrenze' };

interface KontingentKonfig {
  budget: number;
  resetTag: number;
  voll: number;
  neu: number;
  suche: number;
  tagesgrenze: number;
  quotaPauseH: number;
}

function envZahl(name: string, ersatz: number): number {
  const roh = process.env[name];
  if (roh === undefined || roh.trim() === '') return ersatz;
  const wert = Number(roh);
  return Number.isFinite(wert) && wert >= 0 ? wert : ersatz;
}

/** Bei jedem Aufruf neu gelesen, damit ein geaendertes Budget ohne Codeaenderung greift. */
export function kontingentKonfig(): KontingentKonfig {
  const budget = Math.floor(envZahl('SYNAPSE_CONTEXT7_MONATSBUDGET', 1000));
  return {
    budget,
    resetTag: Math.min(28, Math.max(1, Math.floor(envZahl('SYNAPSE_CONTEXT7_RESET_TAG', 1)))),
    voll: envZahl('SYNAPSE_CONTEXT7_STUFE_VOLL', 50),
    neu: envZahl('SYNAPSE_CONTEXT7_STUFE_NEU', 20),
    suche: envZahl('SYNAPSE_CONTEXT7_STUFE_SUCHE', 5),
    tagesgrenze: Math.floor(envZahl('SYNAPSE_CONTEXT7_MAX_PRO_TAG', Math.ceil(budget / 30))),
    quotaPauseH: envZahl('SYNAPSE_CONTEXT7_QUOTA_PAUSE_H', 24),
  };
}

/** Beginn des Abrechnungsmonats, in dem `jetzt` liegt (Reset am resetTag, Ortszeit). */
export function abrechnungsmonat(jetzt: Date, resetTag: number): string {
  let jahr = jetzt.getFullYear();
  let monat = jetzt.getMonth();
  if (jetzt.getDate() < resetTag) {
    monat -= 1;
    if (monat < 0) { monat = 11; jahr -= 1; }
  }
  return `${jahr}-${String(monat + 1).padStart(2, '0')}-${String(resetTag).padStart(2, '0')}`;
}

/** Stufe nach Restbudget. */
export function stufeFuer(verbraucht: number, kk: KontingentKonfig = kontingentKonfig()): Context7Stufe {
  if (kk.budget <= 0) return 'aus';
  const rest = ((kk.budget - verbraucht) / kk.budget) * 100;
  if (rest > kk.voll) return 'voll';
  if (rest > kk.neu) return 'nur_neue';
  if (rest > kk.suche) return 'nur_suche';
  return 'aus';
}

/**
 * Verbrauch, bis zu dem eine Aufrufart noch erlaubt ist (erlaubt, solange verbraucht < Wert).
 * Passt genau zu stufeFuer: bei Budget 1000 duerfen Update-Checks bis 499, neue bis 799, Suche bis 949.
 */
function grenzeFuer(art: Context7Aufrufart, kk: KontingentKonfig): number {
  const schwelle = art === 'update' ? kk.voll : art === 'neu' ? kk.neu : kk.suche;
  return Math.floor(kk.budget * (1 - schwelle / 100));
}

let zeileGesichert = false;

async function sichereZeile(): Promise<void> {
  if (zeileGesichert) return;
  await getPool().query(`INSERT INTO context7_automatik_stand (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  zeileGesichert = true;
}

let letzteStufe: Context7Stufe | null = null;

/** Loggt einen Stufenwechsel (einmal je Wechsel und Prozess). */
function meldeStufe(stufe: Context7Stufe, verbraucht: number, budget: number, monat: string): void {
  if (letzteStufe !== null && letzteStufe !== stufe) {
    console.error(`[context7-kontingent] Stufe ${letzteStufe} -> ${stufe} (${verbraucht}/${budget} Aufrufe im Monat ab ${monat})`);
  }
  letzteStufe = stufe;
}

/**
 * Reserviert EINEN Context7-Aufruf (atomar in PG). Zaehlt Monat, Tag und Gesamt hoch, wenn die
 * Aufrufart in der aktuellen Stufe erlaubt ist, keine Pause laeuft und (nur Automatik) die
 * Tagesgrenze nicht erreicht ist. Sonst nichts gezaehlt und der Grund zurueck.
 */
export async function reserviereContext7Aufruf(art: Context7Aufrufart = 'interaktiv'): Promise<Context7Reservierung> {
  const kk = kontingentKonfig();
  const monat = abrechnungsmonat(new Date(), kk.resetTag);
  const grenze = grenzeFuer(art, kk);
  if (grenze <= 0) return { ok: false, grund: 'monatsbudget' };
  if (art !== 'interaktiv' && kk.tagesgrenze <= 0) return { ok: false, grund: 'tagesgrenze' };

  await sichereZeile();
  const r = await getPool().query<{ abrufe_monat: number }>(
    `UPDATE context7_automatik_stand
        SET abrufe_monat = CASE WHEN monat = $1::date THEN abrufe_monat + 1 ELSE 1 END,
            monat = $1::date,
            abrufe_heute = CASE WHEN tag = CURRENT_DATE THEN abrufe_heute + 1 ELSE 1 END,
            tag = CURRENT_DATE,
            abrufe_gesamt = abrufe_gesamt + 1,
            letzter_aufruf = NOW()
      WHERE id = 1
        AND (pause_bis IS NULL OR pause_bis <= NOW())
        AND (monat IS DISTINCT FROM $1::date OR abrufe_monat < $2::int)
        AND ($4::boolean OR tag IS DISTINCT FROM CURRENT_DATE OR abrufe_heute < $3::int)
      RETURNING abrufe_monat`,
    [monat, grenze, kk.tagesgrenze, art === 'interaktiv'],
  );
  if ((r.rowCount ?? 0) > 0) {
    const verbraucht = r.rows[0].abrufe_monat;
    meldeStufe(stufeFuer(verbraucht, kk), verbraucht, kk.budget, monat);
    return { ok: true };
  }

  // Abgelehnt — Grund bestimmen (fuer Log und Fehlermeldung)
  const k = await context7Kontingent();
  if (k.pause_bis && k.pause_bis.getTime() > Date.now()) return { ok: false, grund: 'pause' };
  if (k.verbraucht >= grenze) return { ok: false, grund: 'monatsbudget' };
  return { ok: false, grund: 'tagesgrenze' };
}

/** Pausiert ALLE Context7-Aufrufe (nach 429/Quota-Antwort), Dauer SYNAPSE_CONTEXT7_QUOTA_PAUSE_H. */
export async function setzeContext7Pause(grund: string): Promise<void> {
  const kk = kontingentKonfig();
  await sichereZeile();
  await getPool().query(
    `UPDATE context7_automatik_stand
        SET pause_bis = NOW() + make_interval(hours => $1::int), pause_grund = $2
      WHERE id = 1`,
    [Math.round(kk.quotaPauseH), grund.slice(0, 500)],
  );
  console.error(`[context7-kontingent] Context7 meldet Kontingent erschoepft — alle Aufrufe pausiert ${kk.quotaPauseH} h: ${grund}`);
}

/** Stand des Kontingents: { monat, verbraucht, budget, stufe, pause_bis, ... }. */
export async function context7Kontingent(): Promise<Context7Kontingent> {
  const kk = kontingentKonfig();
  const monat = abrechnungsmonat(new Date(), kk.resetTag);
  await sichereZeile();
  const z = (await getPool().query<{
    monat_text: string | null;
    abrufe_monat: number;
    heute_gilt: boolean | null;
    abrufe_heute: number;
    pause_bis: Date | null;
    pause_grund: string | null;
  }>(
    `SELECT to_char(monat, 'YYYY-MM-DD') AS monat_text, abrufe_monat, (tag = CURRENT_DATE) AS heute_gilt,
            abrufe_heute, pause_bis, pause_grund
       FROM context7_automatik_stand WHERE id = 1`,
  )).rows[0];
  const verbraucht = z && z.monat_text === monat ? z.abrufe_monat : 0;
  const stufe = stufeFuer(verbraucht, kk);
  meldeStufe(stufe, verbraucht, kk.budget, monat);
  return {
    monat,
    verbraucht,
    budget: kk.budget,
    rest_prozent: kk.budget > 0 ? Math.round(((kk.budget - verbraucht) / kk.budget) * 1000) / 10 : 0,
    stufe,
    heute: z?.heute_gilt ? z.abrufe_heute : 0,
    tagesgrenze: kk.tagesgrenze,
    pause_bis: z?.pause_bis ?? null,
    pause_grund: z?.pause_grund ?? null,
  };
}
