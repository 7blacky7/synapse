/**
 * MODUL: Jev-Kosten und Jev-Budget (P15-T33 E0.5, 11.10.2026)
 * ZWECK: Jeder Jev-Aufruf wird mit Kosten in jev_aufrufe gebucht (Summen je Tag, Monat, Projekt,
 *        Funktion). Optional gibt es EINE globale Kostengrenze in USD je Abrechnungsmonat; ist sie
 *        erreicht, pausiert Jev automatisch (jev-schalter.ts liest die Pause wie einen Schalter).
 *
 * ABRECHNUNG (E0-Messung 1486172c, 424/424 exakt): massgeblich ist usage.cost aus der Antwort von
 *   POST /api/v1/systemone. Fehlt das Feld, gilt input_tokens x Listenpreis (Env
 *   JEV_PREIS_JE_MIO_EINGABE, Standard 0,042 USD je Mio. Eingabe-Tokens). Ausgabe-Tokens sind kostenlos.
 *   Aufladegebuehren von OpenRouter sind nicht eingerechnet.
 *
 * BUDGET (Mechanik von context7-kontingent.ts, Einheit USD statt Aufrufe):
 *   - Eine Zeile jev_budget_stand (id = 1): grenze_usd (NULL = keine Bremse), reset_tag, monat,
 *     verbraucht_usd. Grenze wird ueber das Tool gesetzt (admin jev_budget), nicht per Env.
 *   - VOR dem Aufruf atomare Reservierung (UPDATE ... WHERE verbraucht < grenze RETURNING) um
 *     JEV_BUDGET_RESERVE_USD (Standard 0,001). Danach wird die Differenz zu den echten Kosten
 *     nachgebucht. Nebenlaeufige Aufrufe sehen die Reservierungen der anderen.
 *   - Erreicht verbraucht die Grenze, gilt Jev als pausiert, bis der Abrechnungsmonat wechselt
 *     (reset_tag) oder per Tool zurueckgesetzt / die Grenze angehoben oder entfernt wird.
 *   - Ohne Grenze wird nichts reserviert und der Zaehler nicht gefuehrt (die Summen kommen aus
 *     jev_aufrufe). Beim Setzen einer Grenze startet der Zaehler mit der Monatssumme aus jev_aufrufe.
 * LESEFEHLER: Buchen und Reservieren werfen nie. Ist die DB nicht erreichbar, laeuft Jev weiter
 *   (Reservierung ok, Log einmal) - ein Lesefehler soll Jev nicht still abschalten.
 * KONTOSTAND: GET https://openrouter.ai/api/v1/key (Env JEV_KEY_URL) mit dem normalen Key; zurueck
 *   gehen nur limit, limit_remaining, usage, usage_daily/weekly/monthly, limit_reset. Der Key und
 *   sein Label werden nie ausgegeben.
 */

import { aktuelleAgentAkteurIdentityId } from './agent-bezug.js';
import { getPool } from '../db/client.js';
import { abrechnungsmonat } from './context7-kontingent.js';

export type JevUsdQuelle = 'antwort' | 'listenpreis' | 'keine';

export interface JevAufrufBuchung {
  project: string | null;
  funktion: string;
  agent_id?: string | null;
  /** Intern erfasster Auftraggeber; undefined erlaubt aktuellen Aufruf, null verbietet Rueckfall. */
  identity_id?: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  usd: number;
  usd_quelle: JevUsdQuelle;
  ms: number | null;
  ok: boolean;
  fehler?: string | null;
}

const STANDARD_PREIS_JE_MIO = 0.042;
const STANDARD_RESERVE_USD = 0.001;
const DB_ZEITLIMIT_MS = 3000;

function envZahl(name: string, ersatz: number): number {
  const roh = process.env[name]?.trim();
  if (!roh) return ersatz;
  const n = Number(roh);
  return Number.isFinite(n) && n >= 0 ? n : ersatz;
}

/** Listenpreis je Mio. Eingabe-Tokens (Fallback, wenn usage.cost fehlt). */
export function jevPreisJeMio(): number {
  return envZahl('JEV_PREIS_JE_MIO_EINGABE', STANDARD_PREIS_JE_MIO);
}

/** USD eines Aufrufs: usage.cost, sonst input_tokens x Listenpreis, sonst 0. */
export function jevKostenAusUsage(usage: { input_tokens?: unknown; cost?: unknown } | undefined | null): { usd: number; quelle: JevUsdQuelle } {
  if (usage && typeof usage.cost === 'number' && Number.isFinite(usage.cost)) return { usd: usage.cost, quelle: 'antwort' };
  if (usage && typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)) {
    return { usd: (usage.input_tokens * jevPreisJeMio()) / 1e6, quelle: 'listenpreis' };
  }
  return { usd: 0, quelle: 'keine' };
}

/** Abfrage mit Zeitlimit: eine haengende DB darf keinen Jev-Aufruf aufhalten. */
async function mitZeitlimit<T>(p: Promise<T>): Promise<T> {
  p.catch(() => undefined);
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        t = setTimeout(() => reject(new Error(`Zeitlimit ${DB_ZEITLIMIT_MS} ms`)), DB_ZEITLIMIT_MS);
        t.unref?.();
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

let buchFehlerGemeldet = false;
function meldeDbFehler(was: string, err: unknown): void {
  if (buchFehlerGemeldet) return;
  buchFehlerGemeldet = true;
  console.error(`[jev-kosten] ${was} fehlgeschlagen (weitere Meldungen unterdrueckt): ${err instanceof Error ? err.message : String(err)}`);
}

/** Schreibt eine Zeile in jev_aufrufe. Wirft nie. */
export async function bucheJevAufruf(b: JevAufrufBuchung): Promise<void> {
  try {
    await mitZeitlimit(getPool().query(
      `INSERT INTO jev_aufrufe (project, funktion, agent_id, input_tokens, output_tokens, usd, usd_quelle, ms, ok, fehler, identity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [b.project, b.funktion, b.agent_id ?? null, b.input_tokens, b.output_tokens, b.usd, b.usd_quelle, b.ms, b.ok,
        b.fehler ? b.fehler.slice(0, 500) : null, b.identity_id !== undefined ? b.identity_id : aktuelleAgentAkteurIdentityId(b.agent_id)],
    ));
    buchFehlerGemeldet = false;
  } catch (err) {
    meldeDbFehler('Buchen in jev_aufrufe', err);
  }
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface JevBudgetStand {
  /** NULL = keine Grenze, keine Bremse */
  grenze_usd: number | null;
  reset_tag: number;
  /** Beginn des laufenden Abrechnungsmonats (YYYY-MM-DD) */
  monat: string;
  /** Zaehler im laufenden Monat (inkl. laufender Reservierungen); ohne Grenze 0 */
  verbraucht_usd: number;
  rest_usd: number | null;
  pausiert: boolean;
  gesetzt_von: string | null;
  gesetzt_am: string | null;
  hinweis?: string;
}

interface BudgetZeile {
  grenze_usd: string | number | null;
  reset_tag: number;
  monat_text: string | null;
  verbraucht_usd: string | number;
  gesetzt_von: string | null;
  gesetzt_am: Date | null;
}

const zahl = (x: string | number | null | undefined): number => (x === null || x === undefined ? 0 : Number(x));

function alsBudgetStand(z: BudgetZeile | undefined): JevBudgetStand {
  const resetTag = z?.reset_tag ?? 1;
  const monat = abrechnungsmonat(new Date(), resetTag);
  const grenze = z && z.grenze_usd !== null ? Number(z.grenze_usd) : null;
  const verbraucht = grenze !== null && z?.monat_text === monat ? Math.round(zahl(z.verbraucht_usd) * 1e12) / 1e12 : 0;
  const pausiert = grenze !== null && verbraucht >= grenze;
  return {
    grenze_usd: grenze,
    reset_tag: resetTag,
    monat,
    verbraucht_usd: verbraucht,
    rest_usd: grenze !== null ? Math.max(0, Math.round((grenze - verbraucht) * 1e12) / 1e12) : null,
    pausiert,
    gesetzt_von: z?.gesetzt_von ?? null,
    gesetzt_am: z?.gesetzt_am ? z.gesetzt_am.toISOString() : null,
    ...(pausiert ? { hinweis: budgetText(verbraucht, grenze as number, monat, resetTag) } : {}),
  };
}

function budgetText(verbraucht: number, grenze: number, monat: string, resetTag: number): string {
  return `Jev pausiert: Budget (Kostengrenze) erreicht (${verbraucht.toFixed(6)} von ${grenze} USD im Abrechnungsmonat ab ${monat}). ` +
    `Weiter ab dem naechsten Reset (Tag ${resetTag}) oder per admin(action:"jev_budget", modus:"setzen"|"entfernen"|"zuruecksetzen").`;
}

const SPALTEN = `grenze_usd, reset_tag, to_char(monat, 'YYYY-MM-DD') AS monat_text, verbraucht_usd, gesetzt_von, gesetzt_am`;

/** Stand des Budgets frisch aus PG. Wirft bei DB-Fehler. */
export async function jevBudgetStand(): Promise<JevBudgetStand> {
  const { rows } = await getPool().query<BudgetZeile>(`SELECT ${SPALTEN} FROM jev_budget_stand WHERE id = 1`);
  return alsBudgetStand(rows[0]);
}

// Kurzer Prozess-Cache fuer die Pause (jev-schalter.ts fragt sie bei jedem Wirksamkeits-Check)
let pauseCache: { stand: JevBudgetStand | null; geholt: number } | null = null;
function pauseCacheMs(): number {
  return envZahl('JEV_SCHALTER_CACHE_MS', 5000);
}

/** Gecachte Budget-Pause: Text bei Pause, sonst null. Lesefehler = letzter Stand (ohne: keine Pause). Wirft nie. */
export async function jevBudgetPause(): Promise<string | null> {
  const jetzt = Date.now();
  if (pauseCache && jetzt - pauseCache.geholt < pauseCacheMs()) return pauseCache.stand?.pausiert ? pauseCache.stand.hinweis ?? 'Jev pausiert (Budget).' : null;
  try {
    const stand = await mitZeitlimit(jevBudgetStand());
    pauseCache = { stand, geholt: Date.now() };
  } catch {
    pauseCache = { stand: pauseCache?.stand ?? null, geholt: Date.now() };
  }
  return pauseCache.stand?.pausiert ? pauseCache.stand.hinweis ?? 'Jev pausiert (Budget).' : null;
}

function vergissPauseCache(): void {
  pauseCache = null;
}

let letztePause: boolean | null = null;
function meldePause(pausiert: boolean, text?: string): void {
  if (letztePause !== null && letztePause !== pausiert) {
    console.error(pausiert ? `[jev-budget] ${text ?? 'Jev pausiert (Budget).'}` : '[jev-budget] Jev laeuft wieder (Budget frei).');
  }
  letztePause = pausiert;
}

export type JevBudgetReservierung =
  | { ok: true; reserviert_usd: number; monat: string | null }
  | { ok: false; message: string; stand: JevBudgetStand };

/**
 * Reserviert VOR einem Jev-Aufruf (atomar). Ohne Grenze: nichts reserviert, ok. Mit Grenze: nur wenn
 * verbraucht < grenze. DB-Fehler: ok (Jev bleibt an), Log einmal.
 */
export async function reserviereJevBudget(): Promise<JevBudgetReservierung> {
  try {
    const { rows } = await mitZeitlimit(getPool().query<{ grenze_usd: string | null; reset_tag: number }>(
      'SELECT grenze_usd, reset_tag FROM jev_budget_stand WHERE id = 1',
    ));
    if (rows.length === 0 || rows[0].grenze_usd === null) return { ok: true, reserviert_usd: 0, monat: null };
    const monat = abrechnungsmonat(new Date(), rows[0].reset_tag ?? 1);
    const reserve = envZahl('JEV_BUDGET_RESERVE_USD', STANDARD_RESERVE_USD);
    const r = await mitZeitlimit(getPool().query(
      `UPDATE jev_budget_stand
          SET verbraucht_usd = (CASE WHEN monat = $1::date THEN verbraucht_usd ELSE 0 END) + $2::numeric,
              monat = $1::date
        WHERE id = 1
          AND grenze_usd IS NOT NULL
          AND (CASE WHEN monat = $1::date THEN verbraucht_usd ELSE 0 END) < grenze_usd
        RETURNING verbraucht_usd`,
      [monat, reserve],
    ));
    if ((r.rowCount ?? 0) > 0) {
      meldePause(false);
      return { ok: true, reserviert_usd: reserve, monat };
    }
    const stand = await mitZeitlimit(jevBudgetStand());
    if (!stand.pausiert) return { ok: true, reserviert_usd: 0, monat: null }; // Grenze gerade entfernt
    vergissPauseCache();
    meldePause(true, stand.hinweis);
    return { ok: false, message: stand.hinweis ?? 'Jev pausiert (Budget).', stand };
  } catch (err) {
    meldeDbFehler('Budget-Reservierung', err);
    return { ok: true, reserviert_usd: 0, monat: null };
  }
}

/** Nach dem Aufruf: Differenz echte Kosten - Reservierung nachbuchen (nur im Reservierungsmonat). Wirft nie. */
export async function bucheJevBudget(reservierung: { reserviert_usd: number; monat: string | null }, usd: number): Promise<void> {
  if (!reservierung.monat) return;
  const delta = usd - reservierung.reserviert_usd;
  if (delta === 0) return;
  try {
    await mitZeitlimit(getPool().query(
      `UPDATE jev_budget_stand SET verbraucht_usd = GREATEST(0, verbraucht_usd + $2::numeric)
        WHERE id = 1 AND monat = $1::date`,
      [reservierung.monat, delta],
    ));
    vergissPauseCache();
  } catch (err) {
    meldeDbFehler('Budget-Nachbuchung', err);
  }
}

/** Monatssumme aus jev_aufrufe ab dem Beginn des Abrechnungsmonats. */
async function monatsSumme(monat: string): Promise<number> {
  const { rows } = await getPool().query<{ usd: string | null }>(
    'SELECT COALESCE(sum(usd), 0) AS usd FROM jev_aufrufe WHERE zeit >= $1::date',
    [monat],
  );
  return zahl(rows[0]?.usd);
}

/**
 * Grenze setzen (Zahl > 0) oder entfernen (null). reset_tag 1..28 (Standard: bisheriger, sonst 1).
 * Der Zaehler startet mit der Monatssumme aus jev_aufrufe. Wirft bei ungueltiger Eingabe/DB-Fehler.
 */
export async function setzeJevBudget(o: { grenze_usd: number | null; reset_tag?: number; agent?: string | null }): Promise<JevBudgetStand> {
  const grenze = o.grenze_usd;
  if (grenze !== null && (typeof grenze !== 'number' || !Number.isFinite(grenze) || grenze <= 0)) {
    throw new Error('grenze_usd muss eine Zahl > 0 sein (oder modus "entfernen").');
  }
  let resetTag: number | undefined;
  if (o.reset_tag !== undefined && o.reset_tag !== null) {
    if (!Number.isInteger(o.reset_tag) || o.reset_tag < 1 || o.reset_tag > 28) throw new Error('reset_tag muss eine ganze Zahl 1..28 sein.');
    resetTag = o.reset_tag;
  }
  const alt = await getPool().query<{ reset_tag: number }>('SELECT reset_tag FROM jev_budget_stand WHERE id = 1');
  const tag = resetTag ?? alt.rows[0]?.reset_tag ?? 1;
  const monat = abrechnungsmonat(new Date(), tag);
  const verbraucht = grenze !== null ? await monatsSumme(monat) : 0;
  await getPool().query(
    `INSERT INTO jev_budget_stand (id, grenze_usd, reset_tag, monat, verbraucht_usd, gesetzt_von, gesetzt_am, setter_identity_id)
     VALUES (1, $1, $2, $3::date, $4, $5, NOW(), $6)
     ON CONFLICT (id) DO UPDATE SET grenze_usd = EXCLUDED.grenze_usd, reset_tag = EXCLUDED.reset_tag,
       monat = EXCLUDED.monat, verbraucht_usd = EXCLUDED.verbraucht_usd,
       gesetzt_von = EXCLUDED.gesetzt_von, gesetzt_am = EXCLUDED.gesetzt_am, setter_identity_id=EXCLUDED.setter_identity_id`,
    [grenze, tag, monat, verbraucht, o.agent ?? null, aktuelleAgentAkteurIdentityId(o.agent)],
  );
  vergissPauseCache();
  return jevBudgetStand();
}

/** Zaehler des laufenden Monats auf 0 (die Historie in jev_aufrufe bleibt). Hebt eine Budget-Pause auf. */
export async function setzeJevBudgetZurueck(o: { agent?: string | null } = {}): Promise<JevBudgetStand> {
  const st = await jevBudgetStand();
  await getPool().query(
    `UPDATE jev_budget_stand SET verbraucht_usd = 0, monat = $1::date, gesetzt_von = $2, gesetzt_am = NOW(), setter_identity_id=$3 WHERE id = 1`,
    [st.monat, o.agent ?? null, aktuelleAgentAkteurIdentityId(o.agent)],
  );
  vergissPauseCache();
  return jevBudgetStand();
}

// ---------------------------------------------------------------------------
// Kostensummen
// ---------------------------------------------------------------------------

export interface JevKostenZeile { aufrufe: number; usd: number; input_tokens: number; fehlgeschlagen: number }

export interface JevKostenUebersicht {
  seit: string;
  bis: string;
  project: string | null;
  gesamt: JevKostenZeile;
  je_tag: Array<JevKostenZeile & { tag: string }>;
  je_monat: Array<JevKostenZeile & { monat: string }>;
  je_projekt: Array<JevKostenZeile & { project: string | null }>;
  je_funktion: Array<JevKostenZeile & { funktion: string }>;
  hinweis: string;
}

const SUMMEN = `count(*)::int AS aufrufe, COALESCE(sum(usd), 0) AS usd, COALESCE(sum(input_tokens), 0)::bigint AS input_tokens,
  count(*) FILTER (WHERE NOT ok)::int AS fehlgeschlagen`;

function alsKosten<T extends Record<string, unknown>>(z: T): T & JevKostenZeile {
  return { ...z, aufrufe: Number(z.aufrufe), usd: Math.round(zahl(z.usd as string) * 1e12) / 1e12, input_tokens: Number(z.input_tokens), fehlgeschlagen: Number(z.fehlgeschlagen) };
}

/** Summen je Tag (max. 62 juengste), Monat, Projekt, Funktion. Standard: letzte 365 Tage. */
export async function jevKostenUebersicht(o: { seit?: string; bis?: string; project?: string | null } = {}): Promise<JevKostenUebersicht> {
  const bis = o.bis ? new Date(o.bis) : new Date(Date.now() + 60_000);
  const seit = o.seit ? new Date(o.seit) : new Date(Date.now() - 365 * 86_400_000);
  if (Number.isNaN(bis.getTime()) || Number.isNaN(seit.getTime())) throw new Error('seit/bis muessen ISO-Zeitpunkte sein.');
  const project = o.project ?? null;
  const wo = 'WHERE zeit >= $1 AND zeit < $2 AND ($3::text IS NULL OR project = $3)';
  const p = [seit, bis, project];
  const q = async (sql: string) => (await getPool().query(sql, p)).rows as Array<Record<string, unknown>>;
  const [gesamt, tag, monat, projekt, funktion] = await Promise.all([
    q(`SELECT ${SUMMEN} FROM jev_aufrufe ${wo}`),
    q(`SELECT to_char(date_trunc('day', zeit), 'YYYY-MM-DD') AS tag, ${SUMMEN} FROM jev_aufrufe ${wo} GROUP BY 1 ORDER BY 1 DESC LIMIT 62`),
    q(`SELECT to_char(date_trunc('month', zeit), 'YYYY-MM') AS monat, ${SUMMEN} FROM jev_aufrufe ${wo} GROUP BY 1 ORDER BY 1 DESC`),
    q(`SELECT project, ${SUMMEN} FROM jev_aufrufe ${wo} GROUP BY 1 ORDER BY 3 DESC`),
    q(`SELECT funktion, ${SUMMEN} FROM jev_aufrufe ${wo} GROUP BY 1 ORDER BY 3 DESC`),
  ]);
  return {
    seit: seit.toISOString(),
    bis: bis.toISOString(),
    project,
    gesamt: alsKosten(gesamt[0] ?? { aufrufe: 0, usd: 0, input_tokens: 0, fehlgeschlagen: 0 }),
    je_tag: tag.map(alsKosten) as unknown as JevKostenUebersicht['je_tag'],
    je_monat: monat.map(alsKosten) as unknown as JevKostenUebersicht['je_monat'],
    je_projekt: projekt.map(alsKosten) as unknown as JevKostenUebersicht['je_projekt'],
    je_funktion: funktion.map(alsKosten) as unknown as JevKostenUebersicht['je_funktion'],
    hinweis: 'USD laut usage.cost der Jev-Antwort (Fallback input_tokens x Listenpreis). Kalendertage/-monate in DB-Zeit; das Budget rechnet ab reset_tag. Aufladegebuehren nicht enthalten.',
  };
}

// ---------------------------------------------------------------------------
// Kontostand OpenRouter
// ---------------------------------------------------------------------------

const KONTOSTAND_FELDER = ['limit', 'limit_remaining', 'usage', 'usage_daily', 'usage_weekly', 'usage_monthly', 'limit_reset'] as const;

/** GET /api/v1/key — nur Whitelist-Felder; der Key bleibt in jeder Ausgabe geschwaerzt. */
export async function holeJevKontostand(deps: { fetch?: typeof fetch } = {}): Promise<Record<string, unknown>> {
  const key = process.env.JEV_OPENROUTER_API_KEY?.trim() ?? '';
  if (!key) return { verfuegbar: false, message: 'JEV_OPENROUTER_API_KEY fehlt in der Umgebung dieses Prozesses.' };
  const url = process.env.JEV_KEY_URL?.trim() || 'https://openrouter.ai/api/v1/key';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  const schwaerze = (s: string) => s.split(key).join('***');
  try {
    const r = await (deps.fetch ?? fetch)(url, { method: 'GET', headers: { Authorization: `Bearer ${key}` }, signal: ctrl.signal });
    if (!r.ok) return { verfuegbar: false, message: schwaerze(`OpenRouter /key HTTP ${r.status}`) };
    const daten = ((await r.json()) as { data?: Record<string, unknown> }).data ?? {};
    const aus: Record<string, unknown> = { verfuegbar: true, quelle: 'GET /api/v1/key' };
    for (const f of KONTOSTAND_FELDER) if (f in daten) aus[f] = daten[f];
    return aus;
  } catch (err) {
    return { verfuegbar: false, message: schwaerze(`OpenRouter /key nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`) };
  } finally {
    clearTimeout(t);
  }
}
