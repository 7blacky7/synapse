/**
 * P22-T73: Warteschlange des Main-Chats (User 20.10.2026, Vorgaben 68259fd1 + 9a4346cf, Entwurf thought 34df7d4b).
 * Eine User-Nachricht an den Main geht nie verloren, und die Antwort kommt ohne Neu-Senden im selben Chat an:
 *   erreichbar + frei         -> sofort (Chat-Route wie bisher).
 *   erreichbar + beschaeftigt -> Einwurf: Inbox wie bisher (Absender 'user'), die Antwortzeile wartet (art 'einwurf', inbox_id).
 *                                Stellt die Zustellung genau diese Inbox-Nachricht zu, schreibt schliesseEinwurfAb die Antwort
 *                                des Main IN diese Antwortzeile. Kein Buendel.
 *   nicht erreichbar          -> die Antwortzeile bleibt mit status 'wartet' im Verlauf (art 'warten', Grund). fuehreMainWarteschlangeAus
 *                                stellt nach der Wiederherstellung zu: kurze Unterbrechung einzeln in Reihenfolge, lange (aelteste
 *                                wartende >= warteschlange_buendel_sekunden) als EIN Buendel-Turn mit Zeitstempeln; die Antwort
 *                                steht an der letzten Nachricht, die uebrigen verweisen darauf.
 * SPEICHER: der Verlauf selbst (Schema 125, status 'wartet' + meta.warteschlange), kein eigener Ledger. Andere Geraete sehen
 *   Einreihen und Antwort ueber den Live-Abgleich (seit_rev). Nie 'fehler', solange der Main die Nachricht nicht bekommen hat.
 * WIEDERHERSTELLUNG: laeuft kein Main auf der zugewiesenen Runtime, startet der Takt ihn (stelleMainLaufSicher, wie der Chat);
 *   Container selbst stellt die Runtime-Ueberwachung wieder her (Schalter runtime_ueberwachung, P22-T58).
 * SCHALTER main_warteschlange (Produkt-Schalter, Standard AUS, nur ausdruecklich); wirkt nur mit hauptagent_verlauf EIN.
 *   Schwelle: Einstellung warteschlange_buendel_sekunden der Runtime-Ueberwachung (Standard 120 s, Quelle sichtbar).
 * DEBUG: warteschlangeStatus() (GET /api/main-agent/warteschlange): Schalter mit Quelle, Schwelle mit Quelle, wartende Zeilen,
 *   letzter Takt mit Grund.
 */
import { getPool } from '../db/client.js';
import { leseVerlaufSchalter, starteVerlaufAntwort, aktuellesMainModell, zugewieseneMainRuntime } from './hauptagent-verlauf.js';
import { leseVerlaufStufe2Schalter } from './verlauf-tokens.js';
import { leseMainLauf, sendeMainTurn, stelleMainLaufSicher, runtimeDaemonAngemeldet, istMainLaufRuntime, MainLaufFehler } from './hauptagent-lauf.js';
import { leseRuntimeUeberwachungEinstellungen } from './runtime-ueberwachung.js';
import type { SpecialistZielRuntime } from './specialist-queue.js';
import { setzeProfilProduktSchalter } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler, pflichtText } from './agent-profil-verwalter.js';
import type { AusweisAkteur } from './agent-profil-vertrag.js';
import { mainTurnText } from './chat-zitate.js';

export const MAIN_WARTESCHLANGE_FUNKTION = 'main_warteschlange' as const;

/**
 * Codes des dauerhaften Wegs, bei denen die Nachricht den Main NICHT erreicht hat (Start, Wechsel, Ausfall): einreihen statt
 * Fehler. main_turn_zeitlimit/main_turn_fehlgeschlagen gehoeren nicht dazu (der Main hatte die Nachricht).
 */
export const NICHT_ERREICHT_CODES: readonly string[] = [
  'runtime_nicht_bereit', 'runtime_daemon_fehlt', 'runtime_daemon_nicht_erreichbar', 'main_start_fehlgeschlagen', 'main_start_dauert',
  'main_laeuft_nicht', 'main_nicht_verbunden', 'main_laeuft_auf_anderer_runtime', 'standardmodell_unbestimmt', 'wechsel_offen', 'keine_runtime',
];

/** Hoechstens so lange zwischen zwei Zustellversuchen derselben Nachricht (Backoff 2 s * 2^versuche). */
const BACKOFF_MAX_MS = 60_000;
/** Einwurf ohne zuordenbare Antwort (alte Daemons ohne inbox_id, Inbox schon anders verarbeitet): danach abschliessen. */
const EINWURF_OHNE_ZUORDNUNG_MS = 10 * 60_000;

export async function leseWarteschlangeSchalter(): ReturnType<typeof leseVerlaufStufe2Schalter> {
  return leseVerlaufStufe2Schalter(MAIN_WARTESCHLANGE_FUNKTION);
}

/** REST-Weg der Web-UI (nur User, ebene global). Gleicher Speicher wie admin profil_schalter_setzen. */
export async function setzeWarteschlangeSchalter(akteur: AusweisAkteur | null, e: { aktiv: unknown; grund: unknown }): ReturnType<typeof leseWarteschlangeSchalter> {
  if (!akteur || akteur.art !== 'user') throw new ProfilVerwaltungFehler('recht_fehlt', { grund: 'Dieser Weg ist der User-Eingang; Koordinatoren nutzen admin profil_schalter_setzen' });
  if (typeof e.aktiv !== 'boolean') throw new ProfilVerwaltungFehler('aktiv_fehlt');
  const grund = pflichtText(e.grund, 'grund_fehlt');
  await setzeProfilProduktSchalter({ ebene: 'global', funktion: MAIN_WARTESCHLANGE_FUNKTION, aktiv: e.aktiv, grund }, { system: 'user' });
  return leseWarteschlangeSchalter();
}

/** Laeuft gerade ein Wechsel/Neustart des Main? Dann hat ihn keiner: Nachrichten warten bis danach (die Uebergabe kommt vorher). */
export async function mainWechselOffen(identity_id: string): Promise<boolean> {
  const r = await getPool().query(
    `SELECT 1 FROM agent_runtime_auftraege WHERE identity_id = $1 AND art IN ('runtime_wechsel','modellwechsel','neustart')
       AND status IN ('pending','claimed','accepted') LIMIT 1`, [identity_id]);
  return r.rows.length > 0;
}

/** Wirksam nur mit hauptagent_verlauf EIN (die Warteschlange IST der Verlauf). Lesefehler -> AUS. */
export async function warteschlangeAktiv(): Promise<boolean> {
  try {
    return (await leseVerlaufSchalter()).aktiv && (await leseWarteschlangeSchalter()).aktiv;
  } catch {
    return false;
  }
}

export interface WarteEintrag {
  art: 'warten' | 'einwurf';
  /** Kurzer Code (z. B. runtime_nicht_bereit, wechsel_offen, beschaeftigt); die Web-UI zeigt ihn als Grund. */
  grund: string;
  meldung?: string | null;
  inbox_id?: number | null;
}

interface WarteMeta {
  art?: string; grund?: string; meldung?: string | null; inbox_id?: number | null; seit?: string; versuche?: number;
  naechster_versuch?: string | null;
}
function warteMeta(meta: Record<string, unknown> | null | undefined): WarteMeta {
  const w = meta?.warteschlange;
  return w && typeof w === 'object' ? w as WarteMeta : {};
}

/**
 * Antwortzeile auf 'wartet' setzen (aus 'laeuft' bzw. erneut aus 'wartet'); 'seit' bleibt beim ersten Einreihen, die Versuche
 * zaehlen weiter. Der Schreiber der Zeile muss vorher uebergeben() haben. Wirft nie; false = Zeile nicht (mehr) passend.
 */
export async function stelleInWarteschlange(antwort_id: string, e: WarteEintrag, naechster_versuch: Date | null = null): Promise<boolean> {
  try {
    const r = await getPool().query(
      `UPDATE hauptagent_verlauf SET status = 'wartet',
         meta = jsonb_set(meta, '{warteschlange}', jsonb_build_object(
           'art', $2::text, 'grund', $3::text, 'meldung', $4::text, 'inbox_id', $5::bigint,
           'seit', COALESCE(meta->'warteschlange'->>'seit', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
           'versuche', COALESCE((meta->'warteschlange'->>'versuche')::int, 0) + CASE WHEN $6::timestamptz IS NULL THEN 0 ELSE 1 END,
           'naechster_versuch', $6::timestamptz)),
         rev = nextval('hauptagent_verlauf_rev'), aktualisiert_am = NOW()
       WHERE id = $1::bigint AND rolle = 'agent' AND status IN ('laeuft','wartet')`,
      [antwort_id, e.art, e.grund.slice(0, 120), e.meldung ? e.meldung.slice(0, 300) : null, e.inbox_id ?? null,
        naechster_versuch ? naechster_versuch.toISOString() : null]);
    return (r.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Zeilen eines Buendels ausser der Antwortzeile: fertig, ohne eigenen Text, mit Verweis auf die Antwort. */
async function verweiseAufBuendel(ids: string[], antwort_id: string, status: 'fertig' | 'fehler'): Promise<void> {
  if (!ids.length) return;
  const hinweis = status === 'fertig' ? `Beantwortet zusammen mit den uebrigen wartenden Nachrichten (Antwort #${antwort_id})`
    : `Zustellung im Buendel fehlgeschlagen (siehe #${antwort_id})`;
  await getPool().query(
    `UPDATE hauptagent_verlauf SET status = $3, hinweise = hinweise || jsonb_build_array($4::text),
       meta = jsonb_set(meta, '{warteschlange,buendel_antwort_id}', to_jsonb($2::text), true),
       rev = nextval('hauptagent_verlauf_rev'), aktualisiert_am = NOW()
     WHERE id = ANY($1::bigint[]) AND rolle = 'agent' AND status IN ('laeuft','wartet')`, [ids, antwort_id, status, hinweis]);
}

interface Wartende { id: string; user_id: string; user_text: string; user_am: Date; meta: Record<string, unknown>; user_anhaenge?: unknown }

const ZEIT = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Ein Turn fuer alle Nachrichten einer laengeren Unterbrechung, mit Zeitstempeln (User 68259fd1). */
export function buendelText(teil: Array<{ user_text: string; user_am: Date }>, grund: string | null): string {
  return [
    `[${teil.length} Nachrichten des Users, geschrieben waehrend einer Unterbrechung${grund ? ` (${grund})` : ''}, in der du nicht erreichbar warst. `
      + 'Bitte zusammenhaengend beantworten.]',
    ...teil.map(z => `[${ZEIT.format(z.user_am)}] ${z.user_text}`),
  ].join('\n\n');
}

export interface WarteschlangeDienste {
  /** Standardmodell, wenn der Takt den Main starten muss (wie runtime_wechsel). */
  standardModell: (runtime: SpecialistZielRuntime) => Promise<string>;
}
export interface WarteschlangeErgebnis { wartend: number; zugestellt: number; buendel: boolean; grund: string | null }

let letzterTakt: (WarteschlangeErgebnis & { am: string }) | null = null;

/**
 * Ein Takt (API, manager.ts): offene 'warten'-Zeilen der Main-Identitaet zustellen, sobald ein Main auf der zugewiesenen Runtime
 * laeuft und frei ist. Hoechstens ein Takt gleichzeitig (Advisory-Lock). Wirft nie fachlich; grund sagt, warum nichts ging.
 */
export async function fuehreMainWarteschlangeAus(o: {
  identity_id: string; runtime: string | null | undefined; dienste?: WarteschlangeDienste; jetzt?: number;
}): Promise<WarteschlangeErgebnis> {
  const erg: WarteschlangeErgebnis = { wartend: 0, zugestellt: 0, buendel: false, grund: null };
  const ende = (grund: string | null): WarteschlangeErgebnis => {
    erg.grund = grund;
    letzterTakt = { ...erg, am: new Date().toISOString() };
    return erg;
  };
  if (!(await warteschlangeAktiv())) return ende('schalter_aus');
  const sperre = await getPool().connect();
  try {
    const l = await sperre.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', ['synapse-main-warteschlange']);
    if (!l.rows[0]?.ok) return ende('andere_instanz');
    try {
      return ende(await takt(o, erg));
    } finally {
      await sperre.query('SELECT pg_advisory_unlock(hashtext($1))', ['synapse-main-warteschlange']).catch(() => undefined);
    }
  } finally {
    sperre.release();
  }
}

async function takt(o: { identity_id: string; runtime: string | null | undefined; dienste?: WarteschlangeDienste; jetzt?: number },
  erg: WarteschlangeErgebnis): Promise<string | null> {
  const r = await getPool().query<Wartende>(
    `SELECT a.id::text AS id, u.id::text AS user_id, u.text AS user_text, u.erstellt_am AS user_am, a.meta, u.anhaenge AS user_anhaenge
       FROM hauptagent_verlauf a JOIN hauptagent_verlauf u ON u.id = a.antwort_auf
      WHERE a.identity_id = $1 AND a.status = 'wartet' ORDER BY a.id LIMIT 50`, [o.identity_id]);
  erg.wartend = r.rows.length;
  if (!r.rows.length) return null;
  const jetzt = o.jetzt ?? Date.now();
  await raeumeEinwuerfeAuf(o.identity_id, r.rows.filter(z => warteMeta(z.meta).art === 'einwurf'), jetzt);
  const wartend = r.rows.filter(z => warteMeta(z.meta).art !== 'einwurf');
  if (!wartend.length) return 'nur_einwuerfe';
  const erste = warteMeta(wartend[0].meta);
  if (erste.naechster_versuch && Date.parse(erste.naechster_versuch) > jetzt) return 'backoff';
  if (!istMainLaufRuntime(o.runtime)) return 'keine_runtime';
  const runtime = o.runtime;
  if (await mainWechselOffen(o.identity_id)) return 'wechsel_offen';
  const stand = await leseMainLauf(o.identity_id, runtime);
  if (stand.zustand !== 'laeuft') {
    if (stand.zustand === 'aus' && o.dienste && await runtimeDaemonAngemeldet(runtime)) {
      try {
        await stelleMainLaufSicher({ identity_id: o.identity_id, runtime, modell: await o.dienste.standardModell(runtime), warte_ms: 0 });
      } catch (err) {
        return 'start_fehlgeschlagen: ' + (err instanceof MainLaufFehler ? err.code : (err as Error).message ?? 'fehler');
      }
    }
    return stand.zustand === 'aus' ? 'main_wird_gestartet' : 'main_startet';
  }
  if (stand.wrapper?.busy) return 'beschaeftigt';
  const einst = await leseRuntimeUeberwachungEinstellungen().catch(() => null);
  const schwelleMs = (einst?.warteschlange_buendel_sekunden.wert ?? 120) * 1000;
  const buendel = wartend.length > 1 && jetzt - new Date(wartend[0].user_am).getTime() >= schwelleMs;
  const teil = buendel ? wartend : [wartend[0]];
  const ziel = teil[teil.length - 1];
  // P22-T168: Zitat-Anhaenge der User-Zeile gehen als Block mit (wie beim direkten Senden).
  const text = buendel ? buendelText(teil.map(z => ({ ...z, user_text: mainTurnText(z.user_text, z.user_anhaenge) })), erste.grund ?? null)
    : mainTurnText(ziel.user_text, ziel.user_anhaenge);
  const ids = teil.map(z => z.id);
  // Nur die Antwortzeile laeuft (sie hat einen Schreiber). Die uebrigen Buendel-Zeilen warten bis zum Ergebnis – der Takt haelt die
  // Sperre, sonst fasst niemand 'warten'-Zeilen an –, damit sie nie als verwaiste laufende Antwort abgebrochen werden.
  const c = await getPool().query(
    `UPDATE hauptagent_verlauf SET status = 'laeuft', rev = nextval('hauptagent_verlauf_rev'), aktualisiert_am = NOW()
      WHERE id = $1::bigint AND status = 'wartet'`, [ziel.id]);
  if (!c.rowCount) return 'konkurrenz';
  const modell = await aktuellesMainModell(o.identity_id).catch(() => null);
  const w = starteVerlaufAntwort(ziel.id, {
    modell, identity_id: o.identity_id, user_id: ziel.user_id, user_text: text, runtime,
    meta: { ...ziel.meta, warteschlange: { ...warteMeta(ziel.meta), zugestellt_am: new Date(jetzt).toISOString(), ...(buendel ? { buendel: teil.length } : {}) } },
  });
  w.ereignis('runtime', { hauptagent: { weg: 'dauerhaft', schritt: 'aus_warteschlange' } });
  try {
    const t = await sendeMainTurn({ identity_id: o.identity_id, runtime, nachricht: text, absender: 'user' });
    if (t.art === 'zugestellt') {
      // Inzwischen beschaeftigt: als Einwurf weiter (die Antwort kommt ueber die Zustellung dieser Inbox-Nachricht).
      await w.uebergeben();
      await stelleInWarteschlange(ziel.id, { art: 'einwurf', grund: 'beschaeftigt', inbox_id: t.inbox_id });
      if (buendel) await verweiseAufBuendel(ids.slice(0, -1), ziel.id, 'fertig');
      return 'einwurf';
    }
    if (t.text) w.ereignis('delta', { content: t.text });
    w.ereignis('usage', t.usage);
    await w.abschliessen('fertig', { laufkontext: { hauptagent_weg: 'dauerhaft', aus_warteschlange: true } });
    if (buendel) await verweiseAufBuendel(ids.slice(0, -1), ziel.id, 'fertig');
    erg.zugestellt = teil.length;
    erg.buendel = buendel;
    return null;
  } catch (err) {
    const code = err instanceof MainLaufFehler ? err.code : 'fehler';
    const meldung = err instanceof MainLaufFehler && typeof err.details?.meldung === 'string' ? err.details.meldung : (err as Error)?.message ?? null;
    if (NICHT_ERREICHT_CODES.includes(code)) {
      await w.uebergeben();
      const versuche = (erste.versuche ?? 0) + 1;
      const naechster = new Date(jetzt + Math.min(BACKOFF_MAX_MS, 2_000 * 2 ** Math.min(versuche, 5)));
      for (const z of teil) await stelleInWarteschlange(z.id, { art: 'warten', grund: code, meldung }, naechster);
      return 'nicht_erreicht: ' + code;
    }
    await w.abschliessen('fehler', { fehler: code + (meldung ? ': ' + meldung : '') });
    if (buendel) await verweiseAufBuendel(ids.slice(0, -1), ziel.id, 'fehler');
    return 'fehler: ' + code;
  }
}

/**
 * Einwuerfe, deren Antwort nicht mehr zugeordnet werden kann, abschliessen statt ewig warten: Inbox-Zustellung schon erledigt
 * (z. B. vom Main selbst gelesen) oder ohne inbox_id nach EINWURF_OHNE_ZUORDNUNG_MS.
 */
async function raeumeEinwuerfeAuf(identity_id: string, einwuerfe: Wartende[], jetzt: number): Promise<void> {
  for (const z of einwuerfe) {
    const m = warteMeta(z.meta);
    let erledigt = false;
    if (m.inbox_id) {
      const s = await getPool().query<{ processed: boolean | null; zustellung: string | null }>(
        `SELECT i.processed, (SELECT status FROM agent_zustellungen WHERE identity_id = $2 AND weg = 'inbox' AND message_id = i.id) AS zustellung
           FROM specialist_inbox i WHERE i.id = $1`, [m.inbox_id, identity_id]);
      const q = s.rows[0];
      erledigt = !q || (q.processed === true && q.zustellung !== 'pending');
    } else {
      erledigt = jetzt - Date.parse(m.seit ?? new Date(jetzt).toISOString()) > EINWURF_OHNE_ZUORDNUNG_MS;
    }
    if (!erledigt) continue;
    await getPool().query(
      `UPDATE hauptagent_verlauf SET status = 'fertig', hinweise = hinweise || jsonb_build_array($2::text),
         rev = nextval('hauptagent_verlauf_rev'), aktualisiert_am = NOW()
       WHERE id = $1::bigint AND status = 'wartet'`,
      [z.id, 'Als Einwurf in die laufende Arbeit zugestellt; die Antwort steht in der Antwort des Main darauf bzw. davor.']);
  }
}

/**
 * Zustellung einer Einwurf-Inbox-Nachricht (hauptagent-zustellung.ts): die Antwort des Main gehoert in die wartende Antwortzeile
 * der User-Nachricht. false = keine passende Zeile (dann schreibt die Zustellung wie bisher ein eigenes Paar). Wirft nie.
 */
export async function schliesseEinwurfAb(identity_id: string, inbox_id: number,
  e: { response?: unknown; tokens?: { input?: unknown; output?: unknown; kontext?: unknown } | null }): Promise<boolean> {
  try {
    const r = await getPool().query<{ id: string; user_id: string; user_text: string; meta: Record<string, unknown> }>(
      `UPDATE hauptagent_verlauf a SET status = 'laeuft', rev = nextval('hauptagent_verlauf_rev'), aktualisiert_am = NOW()
         FROM hauptagent_verlauf u
        WHERE u.id = a.antwort_auf AND a.identity_id = $1 AND a.status = 'wartet' AND a.meta->'warteschlange'->>'art' = 'einwurf'
          AND a.meta->'warteschlange'->>'inbox_id' = $2::text
        RETURNING a.id::text AS id, u.id::text AS user_id, u.text AS user_text, a.meta`, [identity_id, String(inbox_id)]);
    const z = r.rows[0];
    if (!z) return false;
    const runtime = await zugewieseneMainRuntime().catch(() => null);
    const w = starteVerlaufAntwort(z.id, {
      modell: await aktuellesMainModell(identity_id).catch(() => null), identity_id, user_id: z.user_id, user_text: z.user_text, runtime,
      meta: { ...z.meta, warteschlange: { ...warteMeta(z.meta), zugestellt_am: new Date().toISOString() } },
      // B5: Dauer ab dem Einwurf statt '0.0 s' (die Antwort entstand waehrend des laufenden Zugs).
      ...(warteMeta(z.meta).seit && Number.isFinite(Date.parse(warteMeta(z.meta).seit!)) ? { start_ms: Date.parse(warteMeta(z.meta).seit!) } : {}),
    });
    w.ereignis('runtime', { hauptagent: { weg: 'dauerhaft', schritt: 'einwurf_beantwortet' } });
    if (typeof e.response === 'string' && e.response) w.ereignis('delta', { content: e.response });
    const t = e.tokens ?? {};
    if (typeof t.input === 'number' || typeof t.output === 'number') {
      w.ereignis('usage', { inputTokens: t.input, outputTokens: t.output, ...(typeof t.kontext === 'number' ? { kontextTokens: t.kontext } : {}) });
    }
    await w.abschliessen('fertig', { laufkontext: { hauptagent_weg: 'dauerhaft', einwurf: true } });
    return true;
  } catch {
    return false;
  }
}

export interface WarteschlangeStatus {
  schalter: Awaited<ReturnType<typeof leseWarteschlangeSchalter>>;
  wirksam: boolean;
  schwelle: { sekunden: number; quelle: string } | null;
  wartend: Array<{ antwort_id: string; art: string | null; grund: string | null; seit: string | null; versuche: number; naechster_versuch: string | null }>;
  letzter_takt: (WarteschlangeErgebnis & { am: string }) | null;
  lesefehler: string | null;
}

/** Debug (GET /api/main-agent/warteschlange): was wartet warum, Schalter und Schwelle mit Quelle, letzter Takt. */
export async function warteschlangeStatus(identity_id: string | null): Promise<WarteschlangeStatus> {
  const schalter = await leseWarteschlangeSchalter();
  const basis: WarteschlangeStatus = { schalter, wirksam: await warteschlangeAktiv(), schwelle: null, wartend: [], letzter_takt: letzterTakt, lesefehler: null };
  try {
    const e = await leseRuntimeUeberwachungEinstellungen();
    basis.schwelle = { sekunden: e.warteschlange_buendel_sekunden.wert, quelle: e.warteschlange_buendel_sekunden.quelle };
    if (!identity_id) return basis;
    const r = await getPool().query<{ id: string; meta: Record<string, unknown> }>(
      `SELECT id::text AS id, meta FROM hauptagent_verlauf WHERE identity_id = $1 AND status = 'wartet' ORDER BY id LIMIT 200`, [identity_id]);
    basis.wartend = r.rows.map(z => {
      const m = warteMeta(z.meta);
      return { antwort_id: z.id, art: m.art ?? null, grund: m.grund ?? null, seit: m.seit ?? null, versuche: m.versuche ?? 0, naechster_versuch: m.naechster_versuch ?? null };
    });
    return basis;
  } catch (error) {
    return { ...basis, lesefehler: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }
}
