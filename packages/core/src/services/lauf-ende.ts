/**
 * P22-T332 (aus P22-T326, Befund 1994b888 U3; Beleg im Ergebnis-thought): Der Lauf (agent_identitaet_laeufe) eines beendeten
 * Plattform-Wrappers blieb 'aktiv'. Laeufe enden bisher NUR durch Abloesung (neuer Lauf bei chat(anmelden)) oder Deaktivierung.
 * Weder stop (wrapper-bridge deregister -> upsertWrapperStatus status stopped) noch Absturz/Container-Neustart
 * (markiereWrapperAbgestuerzt/reapLokaleWrapper -> vermerkeWrapperEnde, status crashed) beendeten den Lauf. Folge: Web-UI
 * (Agententeam 'Lauf'), Anmelde-Uebersicht und der Modellwechsel (P22-T326 F2) sahen einen lebenden Agenten.
 * JETZT (Schalter lauf_ende_bei_wrapper_ende, Produkt, je Projekt/global, Standard AUS, nur ausdruecklich): nach jedem Wrapper-Ende
 * (stopped|crashed) werden aktive Laeufe des Projekts, deren Wrapper-Zeile beendet ist, abgeschlossen - status 'abgeloest',
 * abgeloest_durch 'wrapper_ende:<status>:<pid>' (das Schema kennt nur aktiv|abgeloest; kein Schemawechsel). Ein neuer Aufruf
 * derselben Identitaet legt wie bisher implizit einen neuen Lauf an (agent-lauf.ts).
 * ZUORDNUNG (rein, laufEndeEntscheidung): Ende = last_activity der beendeten Wrapper-Zeile (deregister setzt sie auf NOW(), der
 * Absturzpfad laesst das letzte Lebenszeichen stehen). Beendet wird nur, wenn der Lauf VOR diesem Ende begann und die Identitaet
 * danach nicht mehr aktiv war (zuletzt_aktiv <= Ende + Kulanz). So bleiben Laeufe eines anderen Prozesses (PC-CLI, Desktop,
 * chatgpt.com, schneller Respawn) unberuehrt. Main ist ausgenommen (eigene Laufverwaltung hauptagent-lauf.ts).
 * CAS: das UPDATE greift nur, solange die Wrapper-Zeile noch genau dieses Ende traegt (last_activity exakt) und beendet ist.
 * AUDIT: agent_identitaet_audit aktion 'lauf_beendet'. DEBUG: Rueckgabe {schalter, geprueft, beendet[], uebersprungen[]} und
 * console.debug '[lauf-ende]'. Wirft nie.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';

export const LAUF_ENDE_FUNKTION = 'lauf_ende_bei_wrapper_ende' as const;
/** Kulanz fuer Aktivitaet nach dem Ende (Erkennung/Abmeldung beruehrt zuletzt_aktiv noch kurz). Code-Standard. */
export const LAUF_ENDE_KULANZ_MS = 120_000;
/** Hoechstens so viele Kandidaten je Aufruf (ein Projekt). */
const MAX_JE_LAUF = 200;

export interface LaufEndeKandidat {
  lauf_id: string; identity_id: string; rolle: string; lauf_seit: string | Date | null; zuletzt_aktiv: string | Date | null;
  wrapper_status: string | null; wrapper_pid?: number | null; wrapper_ende: string | null; beendet_ursache?: string | null;
}
export type LaufEndeGrund = 'wrapper_beendet' | 'main_ausgenommen' | 'wrapper_lebt' | 'ende_unbekannt' | 'lauf_nach_wrapper_ende' | 'aktiv_nach_wrapper_ende';

const ms = (v: unknown): number => v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : NaN;

/** Rein, testbar: gehoert der aktive Lauf zum beendeten Wrapper? */
export function laufEndeEntscheidung(k: LaufEndeKandidat, kulanzMs = LAUF_ENDE_KULANZ_MS): { beenden: boolean; grund: LaufEndeGrund } {
  if (k.rolle === 'main') return { beenden: false, grund: 'main_ausgenommen' };
  if (k.wrapper_status !== 'stopped' && k.wrapper_status !== 'crashed') return { beenden: false, grund: 'wrapper_lebt' };
  const ende = ms(k.wrapper_ende);
  if (!Number.isFinite(ende)) return { beenden: false, grund: 'ende_unbekannt' };
  const seit = ms(k.lauf_seit);
  if (Number.isFinite(seit) && seit > ende) return { beenden: false, grund: 'lauf_nach_wrapper_ende' };
  const aktiv = ms(k.zuletzt_aktiv);
  if (Number.isFinite(aktiv) && aktiv > ende + kulanzMs) return { beenden: false, grund: 'aktiv_nach_wrapper_ende' };
  return { beenden: true, grund: 'wrapper_beendet' };
}

export async function laufEndeAktiv(project: string): Promise<boolean> {
  try { return (await leseProfilProduktSchalter(LAUF_ENDE_FUNKTION, project)).aktiv; } catch { return false; }
}

export interface LaufEndeErgebnis {
  schalter: { name: string; aktiv: boolean }; project: string; quelle: string; geprueft: number;
  beendet: Array<{ lauf_id: string; identity_id: string; wrapper_status: string | null; wrapper_pid: number | null; wrapper_ende: string | null }>;
  uebersprungen: Array<{ lauf_id: string; identity_id: string; grund: string }>; fehler?: string;
}

/**
 * Nach einem Wrapper-Ende (stopped|crashed): verwaiste aktive Laeufe im Projekt abschliessen (optional nur eine Identitaet).
 * Schalter AUS -> nichts. Wirft nie.
 */
export async function beendeLaeufeNachWrapperEnde(a: { project: string; identity_id?: string | null; quelle: string }): Promise<LaufEndeErgebnis> {
  const erg: LaufEndeErgebnis = { schalter: { name: LAUF_ENDE_FUNKTION, aktiv: false }, project: a.project, quelle: a.quelle, geprueft: 0, beendet: [], uebersprungen: [] };
  try {
    erg.schalter.aktiv = await laufEndeAktiv(a.project);
    if (!erg.schalter.aktiv) return erg;
    const pool = getPool();
    const r = await pool.query<LaufEndeKandidat>(
      `SELECT l.id AS lauf_id, l.identity_id, i.rolle, l.erstellt_am AS lauf_seit, i.zuletzt_aktiv, w.status AS wrapper_status,
              w.wrapper_pid, w.last_activity::text AS wrapper_ende, w.beendet_ursache
         FROM agent_identitaet_laeufe l
         JOIN agent_identitaeten i ON i.id::text = l.identity_id
         JOIN agent_identitaet_wrapper_status w ON w.identity_id = l.identity_id AND w.project = i.project
        WHERE l.status = 'aktiv' AND i.project = $1 AND w.status IN ('stopped','crashed') AND ($2::text IS NULL OR l.identity_id = $2)
        LIMIT ${MAX_JE_LAUF}`, [a.project, a.identity_id ?? null]);
    erg.geprueft = r.rows.length;
    for (const k of r.rows) {
      const e = laufEndeEntscheidung(k);
      if (!e.beenden) { erg.uebersprungen.push({ lauf_id: k.lauf_id, identity_id: k.identity_id, grund: e.grund }); continue; }
      const durch = 'wrapper_ende:' + k.wrapper_status + ':' + (k.wrapper_pid ?? '-');
      const u = await pool.query(
        `UPDATE agent_identitaet_laeufe l SET status = 'abgeloest', abgeloest_am = NOW(), abgeloest_durch = $2
          WHERE l.id = $1 AND l.status = 'aktiv' AND EXISTS (SELECT 1 FROM agent_identitaet_wrapper_status w WHERE w.identity_id = l.identity_id
            AND w.status IN ('stopped','crashed') AND w.last_activity = $3::timestamptz)`, [k.lauf_id, durch, k.wrapper_ende]);
      if (!(u.rowCount ?? 0)) { erg.uebersprungen.push({ lauf_id: k.lauf_id, identity_id: k.identity_id, grund: 'lage_geaendert' }); continue; }
      erg.beendet.push({ lauf_id: k.lauf_id, identity_id: k.identity_id, wrapper_status: k.wrapper_status, wrapper_pid: k.wrapper_pid ?? null, wrapper_ende: k.wrapper_ende });
      try {
        await pool.query(`INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, alt, neu, grund) VALUES ($1, $2, 'lauf_beendet', $3::jsonb, $4::jsonb, $5)`,
          [k.identity_id, 'system:lauf-ende', JSON.stringify({ lauf_id: k.lauf_id, status: 'aktiv' }),
            JSON.stringify({ lauf_id: k.lauf_id, status: 'abgeloest', abgeloest_durch: durch, wrapper_status: k.wrapper_status, wrapper_pid: k.wrapper_pid ?? null,
              wrapper_ende: k.wrapper_ende, beendet_ursache: k.beendet_ursache ?? null, quelle: a.quelle, schalter: LAUF_ENDE_FUNKTION }),
            'P22-T332: Wrapper beendet (' + a.quelle + ')']);
      } catch (err) { console.error('[lauf-ende] Audit nicht geschrieben:', (err as Error)?.message ?? err); }
    }
    if (erg.geprueft) console.debug('[lauf-ende]', { project: a.project, quelle: a.quelle, beendet: erg.beendet.length, uebersprungen: erg.uebersprungen });
    return erg;
  } catch (err) {
    erg.fehler = String((err as Error)?.message ?? err).slice(0, 200);
    console.error('[lauf-ende] nicht ausgefuehrt:', erg.fehler);
    return erg;
  }
}
