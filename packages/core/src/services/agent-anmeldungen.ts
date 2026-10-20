/**
 * P22-T87 Stufe 1 (User-Vorgabe thought 9a8d7989, Nachtrag fd09a00f): Anmelde-Uebersicht je Agent im admin-Tool.
 *
 * ANMELDUNG = nur der Beginn eines neuen Laufs durch den Agenten selbst: chat(anmelden) mit Ausweis (auch chat(register) bzw.
 *   admin(index_stats, sitzung:'neu') mit Ausweis, die denselben Weg nehmen). Start, Neustart, Kontextwechsel (Clear/Compaction)
 *   und Modellwechsel erzeugen je eine Anmeldung. NICHT: Nachrichten-Abholung, Heartbeat, implizite Laeufe (erster Token-Aufruf
 *   ohne Anmeldung) oder sonstige Tool-Aufrufe.
 * QUELLEN (je Feld in 'quellen' der Antwort):
 *   Zeit/Epoch       agent_identitaet_audit aktion 'anmelden' (schreibt meldeAgentMitTokenAn in derselben Transaktion wie den Lauf)
 *   Lauf             agent_identitaet_laeufe (lauf_id, Status, abgeloest_am, herkunftsort)
 *   Aufruf           erster tool_calls-Eintrag des Laufs (zeigt chat(anmelden) | chat(register) | admin(index_stats); 90 Tage Aufbewahrung)
 *   Kontext          letzter Kontextstand des Laufs im Verlauf (hauptagent_verlauf.kontext); beim aktiven Lauf ersatzweise
 *                    wrapper_status (tokens_percent); sonst 'nicht_verfuegbar'
 *   Anlass           abgeleitet: erste_anmeldung | uebernahme_legacy | modellwechsel (Modell des Laufs != Vorlauf, Verlauf) | neuer_lauf
 *                    (Start, Neustart und Kontextwechsel sind serverseitig nicht unterscheidbar; Abstand und Pause helfen)
 *   Legacy (Weg 'legacy', nur auf Wunsch): tool_calls ohne Identitaet, chat(register) bzw. admin(index_stats, sitzung neu|fortsetzung)
 * RECHTE: lesend; User alles, Koordinator nur sein Projekt (pruefeProfilVerwalter, auch Legacy-Koordinator), Main lesend in jedem Projekt.
 * SCHALTER 'agent_anmeldungen' (Produkt-Schalter, Standard AUS bis Abnahme, nur ausdruecklich; projekt > global). AUS -> funktion_aus.
 * DEBUG: anmeldung_debug:true liefert je Zeile audit_id, beginn_art, abgeloest_durch und den Zuordnungsweg von Aufruf/Kontext.
 * Keine Ausweiswerte, keine Argumente, keine Tool-Ergebnisse in der Antwort.
 */
import type { QueryConfig } from 'pg';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler, pruefeProfilVerwalter } from './agent-profil-verwalter.js';
import { MAIN_ROLLE, type AusweisAkteur, type W1bAkteur } from './agent-profil-vertrag.js';

export const AGENT_ANMELDUNGEN_FUNKTION = 'agent_anmeldungen' as const;
export const AGENT_ANMELDUNGEN_ADMIN_ACTIONS = ['anmeldungen'] as const;
export const ANMELDUNG_WEGE = ['ausweis', 'legacy', 'beide'] as const;
export type AnmeldungWeg = typeof ANMELDUNG_WEGE[number];
export const ANMELDUNG_LIMIT_STANDARD = 10;
export const ANMELDUNG_LIMIT_MAX = 100;
/** Obergrenze der Zeilen einer Antwort (alle Agenten zusammen). */
export const ANMELDUNG_ZEILEN_MAX = 500;
/** Fenster um die Anmeldung, in dem der erste Tool-Aufruf des Laufs gesucht wird (Index agent_id, ts). */
const AUFRUF_FENSTER_S = 120;

type Q = QueryConfig & { query_timeout: number };
const ABFRAGE_MS = 20_000;
const q = (text: string, values: unknown[] = []): Q => ({ text, values, query_timeout: ABFRAGE_MS } as Q);
function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }

export const AGENT_ANMELDUNGEN_ADMIN_PARAMETER: Record<string, Record<string, unknown>> = {
  anmeldung_agent: { type: 'string', description: 'anmeldungen: nur dieser Agent (Name, agent_id oder identity_id); ohne = alle des Projekts' },
  anmeldung_seit: { type: 'string', description: 'anmeldungen: nur Anmeldungen ab diesem Zeitpunkt (ISO)' },
  anmeldung_limit: { type: 'number', description: `anmeldungen: juengste N je Agent (1..${ANMELDUNG_LIMIT_MAX}, Standard ${ANMELDUNG_LIMIT_STANDARD})` },
  anmeldung_nur_letzte: { type: 'boolean', description: 'anmeldungen: je Agent nur die juengste Anmeldung' },
  anmeldung_weg: { type: 'string', enum: [...ANMELDUNG_WEGE], description: 'anmeldungen: ausweis (Standard) | legacy (chat register / index_stats sitzung ohne Ausweis) | beide' },
  anmeldung_debug: { type: 'boolean', description: 'anmeldungen: Debug-Felder je Zeile (audit_id, beginn_art, Zuordnung)' },
};

export function istAgentAnmeldungenAdminAction(action: string | undefined): boolean {
  return typeof action === 'string' && (AGENT_ANMELDUNGEN_ADMIN_ACTIONS as readonly string[]).includes(action);
}

export interface AnmeldungenSchalter { aktiv: boolean; quelle: string; ebene: string | null; gesetzt_von: string | null; gesetzt_am: string | null; letzter_fehler: string | null }

export async function leseAnmeldungenSchalter(project: string | null): Promise<AnmeldungenSchalter> {
  const p = await leseProfilProduktSchalter(AGENT_ANMELDUNGEN_FUNKTION, project);
  return { aktiv: p.aktiv, quelle: p.quelle, ebene: p.ebene, gesetzt_von: p.gesetzt_von, gesetzt_am: p.gesetzt_am, letzter_fehler: p.letzter_fehler };
}

const ORTSZEIT = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function zeit(d: Date | string | null | undefined): { iso: string; ortszeit: string } | null {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? null : { iso: x.toISOString(), ortszeit: ORTSZEIT.format(x) };
}
function sekunden(a: Date | string | null | undefined, b: Date | string | null | undefined): number | null {
  if (!a || !b) return null;
  return Math.round((new Date(a).getTime() - new Date(b).getTime()) / 1000);
}
function zahl(v: unknown): number | null {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
}

export interface AnmeldungKontext {
  quelle: 'hauptagent_verlauf' | 'wrapper_status' | 'nicht_verfuegbar';
  stand?: 'letzter_im_lauf' | 'aktuell';
  tokens?: number | null;
  prozent?: number | null;
  fenster?: number | null;
  modell?: string | null;
  gemessen_am?: { iso: string; ortszeit: string } | null;
}

interface AusweisZeile {
  audit_id: string; identity_id: string; wann: Date; context_epoch: number | null; vorher_wann: Date | null;
  agent_id: string; name: string; rolle: string; identitaet_status: string;
  lauf_id: string | null; lauf_status: string | null; beginn_art: string | null; abgeloest_am: Date | null; abgeloest_durch: string | null;
  herkunftsort: string | null; uebernahme: boolean | null;
  aufruf_tool: string | null; aufruf_action: string | null; aufruf_ts: Date | null;
  vorher_letzte_aktivitaet: Date | null;
  kontext_lauf: Record<string, unknown> | null; kontext_am: Date | null; modell_lauf: string | null; modell_vorher: string | null;
  ws_prozent: string | null; ws_input: number | null; ws_fenster: number | null; ws_modell: string | null; ws_am: Date | null;
}

function kontextAus(z: AusweisZeile): AnmeldungKontext {
  const k = z.kontext_lauf;
  if (k && typeof k === 'object') {
    return { quelle: 'hauptagent_verlauf', stand: 'letzter_im_lauf', tokens: zahl(k.tokens), prozent: zahl(k.prozent), fenster: zahl(k.fenster),
      modell: typeof k.modell === 'string' ? k.modell : z.modell_lauf, gemessen_am: zeit(z.kontext_am) };
  }
  if (z.lauf_status === 'aktiv' && (z.ws_prozent !== null || z.ws_input !== null)) {
    return { quelle: 'wrapper_status', stand: 'aktuell', tokens: zahl(z.ws_input), prozent: zahl(z.ws_prozent), fenster: zahl(z.ws_fenster),
      modell: z.ws_modell, gemessen_am: zeit(z.ws_am) };
  }
  return { quelle: 'nicht_verfuegbar' };
}

function anlassAus(z: AusweisZeile): { anlass: string; anlass_quelle: string } {
  if (!z.vorher_wann) return { anlass: 'erste_anmeldung', anlass_quelle: 'audit: keine fruehere Anmeldung dieser Identitaet' };
  if (z.uebernahme) return { anlass: 'uebernahme_legacy', anlass_quelle: 'agent_identitaet_laeufe.uebernommen_aus' };
  if (z.modell_lauf && z.modell_vorher && z.modell_lauf !== z.modell_vorher) {
    return { anlass: 'modellwechsel', anlass_quelle: `hauptagent_verlauf.modell: ${z.modell_vorher} -> ${z.modell_lauf}` };
  }
  return { anlass: 'neuer_lauf', anlass_quelle: 'Start, Neustart oder Kontextwechsel (Clear/Compaction) sind serverseitig nicht unterscheidbar; siehe abstand_s und pause_vorher_s' };
}

const AUSWEIS_SQL = `
WITH ids AS (
  SELECT id, agent_id, name, rolle, status FROM agent_identitaeten
   WHERE project = $1 AND ($2::text IS NULL OR id = $2 OR agent_id = $2 OR name = $2)
),
anm AS (
  SELECT a.id::text AS audit_id, a.identity_id, a.wann,
         CASE WHEN (a.neu->>'context_epoch') ~ '^[0-9]+$' THEN (a.neu->>'context_epoch')::int END AS context_epoch,
         LAG(a.wann) OVER w AS vorher_wann,
         LAG(CASE WHEN (a.neu->>'context_epoch') ~ '^[0-9]+$' THEN (a.neu->>'context_epoch')::int END) OVER w AS vorher_epoch
    FROM agent_identitaet_audit a
   WHERE a.aktion = 'anmelden' AND a.identity_id IN (SELECT id FROM ids)
  WINDOW w AS (PARTITION BY a.identity_id ORDER BY a.wann, a.id)
),
gef AS (
  SELECT anm.*, ROW_NUMBER() OVER (PARTITION BY identity_id ORDER BY wann DESC, audit_id DESC) AS nr
    FROM anm WHERE ($3::timestamptz IS NULL OR wann >= $3)
)
SELECT g.audit_id, g.identity_id, g.wann, g.context_epoch, g.vorher_wann,
       i.agent_id, i.name, i.rolle, i.status AS identitaet_status,
       l.id AS lauf_id, l.status AS lauf_status, l.beginn_art, l.abgeloest_am, l.abgeloest_durch, l.herkunftsort,
       (l.uebernommen_aus IS NOT NULL) AS uebernahme,
       ta.tool_name AS aufruf_tool, ta.action AS aufruf_action, ta.ts AS aufruf_ts,
       tv.ts AS vorher_letzte_aktivitaet,
       kv.kontext AS kontext_lauf, kv.aktualisiert_am AS kontext_am,
       ml.modell AS modell_lauf, mv.modell AS modell_vorher,
       ws.tokens_percent::text AS ws_prozent, ws.tokens_input AS ws_input, ws.context_ceiling AS ws_fenster,
       COALESCE(ws.model_full_id, ws.model) AS ws_modell, ws.last_activity AS ws_am
  FROM gef g
  JOIN ids i ON i.id = g.identity_id
  LEFT JOIN agent_identitaet_laeufe l ON l.identity_id = g.identity_id AND l.context_epoch = g.context_epoch
  LEFT JOIN agent_identitaet_laeufe vl ON vl.identity_id = g.identity_id AND vl.context_epoch = g.vorher_epoch
  LEFT JOIN LATERAL (
    SELECT t.tool_name, t.action, t.ts FROM tool_calls t
     WHERE t.agent_id = i.agent_id AND t.ts >= g.wann - INTERVAL '5 seconds' AND t.ts <= g.wann + make_interval(secs => $6)
       AND t.lauf_id = l.id
     ORDER BY t.ts, t.id LIMIT 1) ta ON TRUE
  LEFT JOIN LATERAL (
    SELECT t.ts FROM tool_calls t
     WHERE vl.id IS NOT NULL AND t.agent_id = i.agent_id AND t.ts < g.wann AND t.ts >= g.vorher_wann AND t.lauf_id = vl.id
     ORDER BY t.ts DESC LIMIT 1) tv ON TRUE
  LEFT JOIN LATERAL (
    SELECT v.kontext, v.aktualisiert_am FROM hauptagent_verlauf v
     WHERE v.identity_id = g.identity_id AND v.lauf_id = l.id AND v.kontext IS NOT NULL
     ORDER BY v.id DESC LIMIT 1) kv ON TRUE
  LEFT JOIN LATERAL (
    SELECT v.modell FROM hauptagent_verlauf v
     WHERE v.identity_id = g.identity_id AND v.lauf_id = l.id AND v.modell IS NOT NULL
     ORDER BY v.id DESC LIMIT 1) ml ON TRUE
  LEFT JOIN LATERAL (
    SELECT v.modell FROM hauptagent_verlauf v
     WHERE vl.id IS NOT NULL AND v.identity_id = g.identity_id AND v.lauf_id = vl.id AND v.modell IS NOT NULL
     ORDER BY v.id DESC LIMIT 1) mv ON TRUE
  LEFT JOIN wrapper_status ws ON ws.project = $1 AND ws.agent_name = i.agent_id AND l.status = 'aktiv'
 WHERE g.nr <= $4
 ORDER BY g.wann DESC, g.audit_id DESC
 LIMIT $5`;

const LEGACY_SQL = `
WITH roh AS (
  SELECT t.id, t.ts, t.tool_name, t.action,
         COALESCE(NULLIF(t.agent_id, ''), substring(t.args_preview from '"id"\\s*:\\s*"([^"]+)"')) AS agent,
         substring(t.args_preview from '"sitzung"\\s*:\\s*"(neu|fortsetzung)"') AS sitzung
    FROM tool_calls t
   WHERE t.project = $1 AND t.identity_id IS NULL AND t.ok IS NOT FALSE AND ($3::timestamptz IS NULL OR t.ts >= $3)
     AND ((t.tool_name = 'chat' AND t.action = 'register')
       OR (t.tool_name = 'admin' AND t.action = 'index_stats' AND t.args_preview ~ '"sitzung"\\s*:\\s*"(neu|fortsetzung)"'))
),
gef AS (
  SELECT roh.*, LAG(ts) OVER (PARTITION BY agent ORDER BY ts, id) AS vorher_wann,
         ROW_NUMBER() OVER (PARTITION BY agent ORDER BY ts DESC, id DESC) AS nr
    FROM roh WHERE agent IS NOT NULL AND ($2::text IS NULL OR agent = $2)
)
SELECT g.id::text AS tool_call_id, g.ts, g.tool_name, g.action, g.agent, g.sitzung, g.vorher_wann
  FROM gef g WHERE g.nr <= $4 ORDER BY g.ts DESC, g.id DESC LIMIT $5`;

interface LegacyZeile { tool_call_id: string; ts: Date; tool_name: string; action: string; agent: string; sitzung: string | null; vorher_wann: Date | null }

export interface AnmeldungenAbfrage {
  project: string;
  agent?: string | null;
  seit?: string | null;
  limit?: number;
  nur_letzte?: boolean;
  weg?: AnmeldungWeg;
  debug?: boolean;
}

/** Lesestelle (ohne Rechte-/Schalterpruefung; die macht fuehreAgentAnmeldungenAdminAus). */
export async function leseAnmeldungen(a: AnmeldungenAbfrage): Promise<Record<string, unknown>> {
  const je = a.nur_letzte ? 1 : Math.min(ANMELDUNG_LIMIT_MAX, Math.max(1, Math.floor(a.limit ?? ANMELDUNG_LIMIT_STANDARD)));
  const weg = a.weg ?? 'ausweis';
  const pool = getPool();
  const zeilen: Array<Record<string, unknown>> = [];
  let gekappt = false;
  if (weg !== 'legacy') {
    const r = await pool.query<AusweisZeile>(q(AUSWEIS_SQL, [a.project, a.agent ?? null, a.seit ?? null, je, ANMELDUNG_ZEILEN_MAX + 1, AUFRUF_FENSTER_S]));
    gekappt = r.rows.length > ANMELDUNG_ZEILEN_MAX;
    for (const z of r.rows.slice(0, ANMELDUNG_ZEILEN_MAX)) {
      const anlass = anlassAus(z);
      zeilen.push({
        agent: z.agent_id, name: z.name, identity_id: z.identity_id, rolle: z.rolle,
        ...(z.identitaet_status !== 'aktiv' ? { identitaet_status: z.identitaet_status } : {}),
        weg: 'ausweis', zeit: zeit(z.wann), lauf_id: z.lauf_id, context_epoch: z.context_epoch,
        lauf_status: z.lauf_status, abgeloest_am: zeit(z.abgeloest_am),
        aufruf: z.aufruf_tool ? `${z.aufruf_tool}(${z.aufruf_action ?? ''})` : null,
        ...anlass,
        abstand_s: sekunden(z.wann, z.vorher_wann),
        pause_vorher_s: sekunden(z.wann, z.vorher_letzte_aktivitaet),
        ort: z.herkunftsort,
        kontext: kontextAus(z),
        ...(a.debug ? { debug: {
          audit_id: z.audit_id, beginn_art: z.beginn_art, abgeloest_durch: z.abgeloest_durch,
          aufruf_zuordnung: z.aufruf_tool ? `tool_calls agent_id+lauf_id, ${AUFRUF_FENSTER_S} s nach der Anmeldung` : 'kein tool_calls-Eintrag des Laufs im Fenster (Aufbewahrung 90 Tage)',
          kontext_zuordnung: z.kontext_lauf ? 'hauptagent_verlauf identity_id+lauf_id, letzter Eintrag mit kontext'
            : z.lauf_status === 'aktiv' ? 'aktiver Lauf: wrapper_status project+agent_name' : 'kein Kontextstand fuer diesen Lauf',
          modell_lauf: z.modell_lauf, modell_vorher: z.modell_vorher,
          vorher_letzte_aktivitaet: zeit(z.vorher_letzte_aktivitaet),
        } } : {}),
      });
    }
  }
  if (weg !== 'ausweis') {
    const r = await pool.query<LegacyZeile>(q(LEGACY_SQL, [a.project, a.agent ?? null, a.seit ?? null, je, ANMELDUNG_ZEILEN_MAX + 1]));
    gekappt = gekappt || r.rows.length > ANMELDUNG_ZEILEN_MAX;
    for (const z of r.rows.slice(0, ANMELDUNG_ZEILEN_MAX)) {
      const anlass = z.tool_name === 'chat' ? 'start_register' : z.sitzung === 'fortsetzung' ? 'kontextwechsel_fortsetzung' : 'neue_sitzung';
      zeilen.push({
        agent: z.agent, weg: 'legacy', zeit: zeit(z.ts), aufruf: `${z.tool_name}(${z.action}${z.sitzung ? ', sitzung:' + z.sitzung : ''})`,
        anlass, anlass_quelle: 'tool_calls (Aufruf ohne Ausweis)', abstand_s: sekunden(z.ts, z.vorher_wann),
        kontext: { quelle: 'nicht_verfuegbar' } satisfies AnmeldungKontext,
        ...(a.debug ? { debug: { tool_call_id: z.tool_call_id } } : {}),
      });
    }
  }
  zeilen.sort((x, y) => String((y.zeit as { iso: string } | null)?.iso ?? '').localeCompare(String((x.zeit as { iso: string } | null)?.iso ?? '')));
  const agenten = new Map<string, { agent: string; anzahl: number; letzte: unknown }>();
  for (const z of zeilen) {
    const k = `${z.weg}:${z.agent}`;
    const e = agenten.get(k);
    if (e) e.anzahl++; else agenten.set(k, { agent: String(z.agent), anzahl: 1, letzte: z.zeit });
  }
  return {
    project: a.project, weg, je_agent: je, seit: a.seit ?? null, ...(a.agent ? { agent: a.agent } : {}),
    anzahl: zeilen.length, agenten: agenten.size, gekappt,
    letzte_je_agent: [...agenten.values()],
    anmeldungen: zeilen,
    quellen: {
      zeit: 'agent_identitaet_audit (aktion anmelden)', lauf: 'agent_identitaet_laeufe',
      aufruf: 'tool_calls (erster Aufruf des Laufs, 90 Tage)', kontext: 'hauptagent_verlauf.kontext, sonst wrapper_status (nur aktiver Lauf), sonst nicht_verfuegbar',
      anlass: 'abgeleitet aus Audit/Lauf/Verlauf (anlass_quelle je Zeile)', legacy: 'tool_calls ohne Identitaet: chat(register), admin(index_stats, sitzung neu|fortsetzung)',
    },
    hinweis: 'Nur Anmeldungen (neuer Lauf durch den Agenten), keine Abholungen, Heartbeats oder sonstigen Tool-Aufrufe.',
  };
}

function iso(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) fehler('seit_ungueltig', { erwartet: 'ISO-Zeitpunkt' });
  return d.toISOString();
}

/** admin(action:'anmeldungen'): lesend; User, Koordinator des Projekts (auch Legacy), Main. Schalter agent_anmeldungen. */
export async function fuehreAgentAnmeldungenAdminAus(action: string, args: Record<string, unknown>, akteur: W1bAkteur | AusweisAkteur | null): Promise<Record<string, unknown>> {
  try {
    if (!akteur) fehler('recht_fehlt');
    const wer = akteur as AusweisAkteur;
    const projektArg = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : null;
    const project = projektArg ?? (wer.art === 'identitaet' ? wer.principal.project : null);
    if (!project) fehler('project_fehlt');
    const istMain = wer.art === 'identitaet' && wer.principal.rolle === MAIN_ROLLE;
    if (!istMain) await pruefeProfilVerwalter(wer, project);
    const schalter = await leseAnmeldungenSchalter(project);
    if (!schalter.aktiv) {
      return { success: false, action, error: 'funktion_aus', schalter,
        message: "Produkt-Schalter agent_anmeldungen ist AUS (Standard bis Abnahme). Freigabe: admin(action:'profil_schalter_setzen', profil_funktion:'agent_anmeldungen', aktiv:true, ebene, grund)." };
    }
    const weg = args.anmeldung_weg === undefined || args.anmeldung_weg === null ? 'ausweis' : args.anmeldung_weg;
    if (!(ANMELDUNG_WEGE as readonly unknown[]).includes(weg)) fehler('weg_unbekannt', { erlaubt: ANMELDUNG_WEGE });
    const limitRoh = args.anmeldung_limit;
    let limit: number | undefined;
    if (limitRoh !== undefined && limitRoh !== null) {
      limit = Number(limitRoh);
      if (!Number.isInteger(limit) || limit < 1 || limit > ANMELDUNG_LIMIT_MAX) fehler('limit_ungueltig', { min: 1, max: ANMELDUNG_LIMIT_MAX });
    }
    const agent = typeof args.anmeldung_agent === 'string' && args.anmeldung_agent.trim() ? args.anmeldung_agent.trim() : null;
    const r = await leseAnmeldungen({ project, agent, seit: iso(args.anmeldung_seit), limit, nur_letzte: args.anmeldung_nur_letzte === true,
      weg: weg as AnmeldungWeg, debug: args.anmeldung_debug === true });
    return { success: true, action, ...r, ...(args.anmeldung_debug === true ? { schalter, leser: istMain ? 'main' : wer.art } : {}) };
  } catch (err) {
    if (err instanceof ProfilVerwaltungFehler) return { success: false, action, error: err.code, ...(err.details ? { details: err.details } : {}) };
    return { success: false, action, error: 'anmeldungen_fehler', message: ((err as { message?: string } | null)?.message ?? '').slice(0, 120) };
  }
}
