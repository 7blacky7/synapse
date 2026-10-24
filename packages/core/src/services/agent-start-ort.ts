/**
 * P22-T113 (User 24.10.2026): Startort JEDES Agenten in PG (agent_identitaeten.start_ort/start_ziel), damit die API weiss,
 * ueber welchen Daemon sie einen Agenten erreicht, und den Heartbeat dort abschalten kann, wo sie selbst zustellt.
 * ORTE: container = API -> Runtime-Container (Web-UI, target_runtime claude|codex), daemon = API -> lokaler Daemon/Tray (PC,
 *   start_ziel = Hostname, sobald ein PC-Daemon den Job claimt), extern = selbst gestartet und nur angemeldet (Koordinator-CLI,
 *   Subagent mit Ausweis, Web-KI; start_ziel = Herkunft). Gilt fuer alle Sorten (Koordinator, Spezialist, Subagent, Main, API-Agent).
 * HAKEN: enqueueSpecialistJob (spawn/rotate/wake, jeder Daemon-Start), claimPendingSpecialistJob (PC-Hostname nachtragen),
 *   Anmelden (agent-token-tools: extern nur, wenn noch kein Ort bekannt; ein Daemon-Start ueberschreibt extern, nie umgekehrt).
 * SCHALTER: Produkt-Schalter agent_start_ort (je Projekt/global, Standard AUS, nur ausdruecklich). AUS = nichts wird geschrieben,
 *   zustellWegFuer liefert weg 'unbekannt' (Altverhalten: Heartbeat bzw. Ableitung ueber WRAPPER_ZIEL_SQL).
 * DEBUG: zustellWegFuer(identity_id) zeigt Schalter, gespeicherten Ort samt Quelle/Zeitpunkt und den daraus folgenden Weg.
 * Wirft nie: der Startort ist eine Zusatzinformation, nie ein Grund fuer einen fehlgeschlagenen Start.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';

export const AGENT_START_ORT_FUNKTION = 'agent_start_ort' as const;
export const START_ORTE = ['container', 'daemon', 'extern'] as const;
export type StartOrt = typeof START_ORTE[number];

export interface StartOrtEingabe {
  project: string;
  /** Identitaet; fehlt sie, wird sie ueber project + name (agent_id) gesucht. */
  identity_id?: string | null;
  name?: string | null;
  ort: StartOrt;
  ziel?: string | null;
  quelle: string;
  /** wake: nur ergaenzen, nie einen anderen bekannten Ort ueberschreiben (wake ist kein neuer Start). */
  nur_ergaenzen?: boolean;
}

export interface StartOrtStand { start_ort: StartOrt | null; start_ziel: string | null; start_ort_quelle: string | null; start_ort_am: string | null }

function text(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : null;
}

async function schalterAn(project: string): Promise<boolean> {
  try { return (await leseProfilProduktSchalter(AGENT_START_ORT_FUNKTION, project)).aktiv; } catch { return false; }
}

/** Merkt den Startort. extern ueberschreibt nie einen Daemon-/Container-Ort. Liefert true, wenn eine Zeile geschrieben wurde. */
export async function merkeStartOrt(e: StartOrtEingabe): Promise<boolean> {
  try {
    const project = text(e?.project, 256);
    if (!project || !(START_ORTE as readonly string[]).includes(e.ort)) return false;
    if (!(await schalterAn(project))) return false;
    const id = text(e.identity_id, 64);
    const name = text(e.name, 256);
    if (!id && !name) return false;
    const r = await getPool().query(
      `UPDATE agent_identitaeten SET start_ort = $3, start_ziel = $4, start_ort_quelle = $5, start_ort_am = NOW(),
          start_ort_art = CASE WHEN $3 = 'extern' THEN start_ort_art ELSE NULL END
        WHERE project = $1 AND (CASE WHEN $2::text IS NOT NULL THEN id::text = $2 ELSE agent_id = $6 END)
          AND ($3 <> 'extern' OR start_ort IS NULL OR start_ort = 'extern')
          AND NOT ($4::text IS NULL AND start_ort = $3 AND start_ziel IS NOT NULL)
          AND (NOT $7::boolean OR start_ort IS NULL OR start_ort = 'extern' OR start_ort = $3)`,
      [project, id, e.ort, text(e.ziel), text(e.quelle, 80) ?? 'unbekannt', name, e.nur_ergaenzen === true]);
    return (r.rowCount ?? 0) > 0;
  } catch { return false; }
}

/** Startort aus einem Daemon-Job (enqueueSpecialistJob bzw. Claim). Nur Start-Aktionen. */
export async function merkeStartOrtAusJob(j: { project: string; action: string; args: Record<string, unknown>; hostname?: string | null; quelle: string }): Promise<boolean> {
  const a = j.args ?? {};
  // Abnahme R2: spawn_batch startet jedes Mitglied direkt im Daemon (specialist-job-worker) -> je Mitglied merken.
  if (j.action === 'spawn_batch') {
    const liste = Array.isArray(a.specialists) ? a.specialists as unknown[] : [];
    let geschrieben = false;
    for (const s of liste) {
      if (!s || typeof s !== 'object') continue;
      const m = s as Record<string, unknown>;
      const ok = await merkeStartOrtAusJob({ ...j, action: 'spawn', args: { ...m,
        target_runtime: m.target_runtime ?? a.target_runtime, target_hostname: m.target_hostname ?? a.target_hostname } });
      geschrieben = ok || geschrieben;
    }
    return geschrieben;
  }
  if (!['spawn', 'rotate', 'wake'].includes(j.action)) return false;
  const runtime = text(a.target_runtime, 32);
  const name = text(a.name, 256);
  return merkeStartOrt({
    project: j.project,
    identity_id: text(a.identity_id, 64) ?? (name?.startsWith('identity:') ? name.slice(9) : null),
    name: name?.startsWith('identity:') ? null : name,
    ort: runtime ? 'container' : 'daemon',
    ziel: runtime ?? text(j.hostname) ?? text(a.target_hostname),
    quelle: j.quelle,
    // Abnahme R1: wake ohne Ziel loescht keinen bekannten Host/Ort (Guard im UPDATE: ziel null + gleicher Ort = unveraendert).
    nur_ergaenzen: j.action === 'wake',
  });
}

export async function leseStartOrt(identity_id: string): Promise<StartOrtStand | null> {
  try {
    const r = await getPool().query<{ start_ort: StartOrt | null; start_ziel: string | null; start_ort_quelle: string | null; start_ort_am: Date | null }>(
      'SELECT start_ort, start_ziel, start_ort_quelle, start_ort_am FROM agent_identitaeten WHERE id::text = $1', [identity_id]);
    const z = r.rows[0];
    return z ? { start_ort: z.start_ort, start_ziel: z.start_ziel, start_ort_quelle: z.start_ort_quelle, start_ort_am: z.start_ort_am ? z.start_ort_am.toISOString() : null } : null;
  } catch { return null; }
}

export interface StartOrtZustellweg {
  identity_id: string;
  schalter: boolean;
  /** container_daemon / pc_daemon: API stellt ueber diesen Daemon zu; heartbeat: kein Daemon bekannt; unbekannt: Schalter AUS bzw. kein Ort. */
  weg: 'container_daemon' | 'pc_daemon' | 'heartbeat' | 'unbekannt';
  runtime: string | null;
  hostname: string | null;
  /** Nur Auskunft: true = die API kann nicht selbst zustellen (nur der Heartbeat holt ab); null = keine Aussage. Die API schaltet
   *  den Heartbeat NIE um (Korrektur User 24.10.), er bleibt je Agent wie bewusst gesetzt. */
  heartbeat_noetig: boolean | null;
  stand: StartOrtStand | null;
}

/** Schalter agent_start_ort fuer ein Projekt (Lesefehler = AUS). */
export async function startOrtSchalterAktiv(project: string): Promise<boolean> { return schalterAn(project); }

/**
 * Stufe 2: genauere Art eines externen Starts. NUR VORBEREITET (User 24.10.): keine eigene Erkennung; der Tray setzt sie spaeter
 * ueber die API anhand lokaler Claude-Code-/Codex-Prozesse (Spalte start_ort_art).
 */
export const START_ORT_ARTEN = ['desktop_cli', 'web_ki'] as const;
export type StartOrtArt = typeof START_ORT_ARTEN[number];

export interface StartOrtAnzeige {
  ort: StartOrt | null; ziel: string | null; art: StartOrtArt | null; quelle: string | null; am: string | null;
  /** Verstaendliche Bezeichnung fuer API-Antworten und Web-UI. */
  bezeichnung: string;
  /** true = nur Vorgabe aus dem Profil (startrezept.start_ort_vorgabe), noch kein tatsaechlicher Start bekannt. */
  vorgabe: boolean;
}

function bezeichnungFuer(ort: StartOrt, ziel: string | null, art: StartOrtArt | null): string {
  if (ort === 'container') return 'Plattform (Container' + (ziel ? ' ' + ziel : '') + ')';
  if (ort === 'daemon') return 'Daemon/Tray (PC' + (ziel ? ' ' + ziel : '') + ')';
  if (art === 'desktop_cli') return 'Desktop-CLI' + (ziel ? ' · ' + ziel : '');
  if (art === 'web_ki') return 'Web-KI' + (ziel ? ' · ' + ziel : '');
  return 'Extern (selbst gestartet' + (ziel ? ': ' + ziel : '') + ')';
}

/**
 * Anzeige des Startorts. Tatsaechlicher Start vor Vorgabe (startrezept.start_ort_vorgabe {ort, art?, ziel?}): die Vorgabe
 * erscheint nur, solange kein Start bekannt ist, und zaehlt nie fuer die Zustellung. null = nichts bekannt.
 */
export function startOrtAnzeige(z: { start_ort?: unknown; start_ziel?: unknown; start_ort_art?: unknown; start_ort_quelle?: unknown; start_ort_am?: unknown; vorgabe?: unknown }): StartOrtAnzeige | null {
  const art = (START_ORT_ARTEN as readonly string[]).includes(String(z.start_ort_art)) ? z.start_ort_art as StartOrtArt : null;
  if ((START_ORTE as readonly string[]).includes(String(z.start_ort))) {
    const ort = z.start_ort as StartOrt;
    const ziel = text(z.start_ziel);
    const am = z.start_ort_am instanceof Date ? z.start_ort_am.toISOString() : text(z.start_ort_am, 40);
    return { ort, ziel, art: ort === 'extern' ? art : null, quelle: text(z.start_ort_quelle, 80), am, bezeichnung: bezeichnungFuer(ort, ziel, ort === 'extern' ? art : null), vorgabe: false };
  }
  const v = z.vorgabe && typeof z.vorgabe === 'object' ? z.vorgabe as Record<string, unknown> : null;
  if (v && (START_ORTE as readonly string[]).includes(String(v.ort))) {
    const ort = v.ort as StartOrt;
    const vArt = (START_ORT_ARTEN as readonly string[]).includes(String(v.art)) ? v.art as StartOrtArt : null;
    const ziel = text(v.ziel);
    return { ort, ziel, art: ort === 'extern' ? vArt : null, quelle: 'startrezept.start_ort_vorgabe', am: null,
      bezeichnung: 'Vorgabe: ' + bezeichnungFuer(ort, ziel, ort === 'extern' ? vArt : null), vorgabe: true };
  }
  return null;
}

/** Baustein fuer die Zustellung: ueber welchen Daemon erreicht die API diese Identitaet? Wirft nie. */
export async function zustellWegFuer(identity_id: string): Promise<StartOrtZustellweg> {
  const leer: StartOrtZustellweg = { identity_id, schalter: false, weg: 'unbekannt', runtime: null, hostname: null, heartbeat_noetig: null, stand: null };
  try {
    const p = await getPool().query<{ project: string }>('SELECT project FROM agent_identitaeten WHERE id::text = $1', [identity_id]);
    if (!p.rows[0]) return leer;
    const schalter = await schalterAn(p.rows[0].project);
    if (!schalter) return leer;
    const stand = await leseStartOrt(identity_id);
    const basis = { ...leer, schalter: true, stand };
    if (stand?.start_ort === 'container') return { ...basis, weg: 'container_daemon', runtime: stand.start_ziel, heartbeat_noetig: false };
    if (stand?.start_ort === 'daemon') return { ...basis, weg: 'pc_daemon', hostname: stand.start_ziel, heartbeat_noetig: false };
    if (stand?.start_ort === 'extern') return { ...basis, weg: 'heartbeat', heartbeat_noetig: true };
    return basis;
  } catch { return leer; }
}
