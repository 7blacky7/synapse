/**
 * P22-T134 (User 25.10.2026): Mod-Inbox. Interaktive Claude-Code-Sitzungen am PC ohne Wrapper (Koordinator-CLI, Subagent mit
 * Ausweis; start_ort extern) bekommen Nachrichten ueber den lokalen Daemon: eine Claude-Code-Mod in der Sitzung wartet am Daemon
 * und startet mit $.prompt.submit einen Turn (Beleg thought 5b2efc34). Ersetzt cc-wrap/cc-send, auch wenn der User nicht da ist.
 * ABLAUF: Der Daemon meldet je Takt die Sitzungen mit wartender Mod (POST /api/daemon/mod-inbox, Ausweis aus dem Transcript
 *   wie cli-verlauf). Die API merkt sich Identitaet -> Host im Speicher (Lebenszeichen wie daemon-bruecke, kein PG; nach einem
 *   API-Neustart meldet der Daemon im naechsten Takt neu). Der Zustell-Takt (agent-runtime/manager.ts) stellt jeder frisch
 *   gemeldeten Identitaet ueber fuehreIdentitaetsZustellungAus mit target_hostname zu: gleicher Ledger, Wasserstand und
 *   dieselbe Quittung wie P22-T113. Der Daemon fuehrt 'zustellen' ohne Wrapper ueber die Mod aus (mod-inbox.ts im Daemon).
 * SCHALTER: Produkt-Schalter mod_inbox (je Projekt/global, Standard AUS, nur ausdruecklich). AUS = Meldungen werden mit
 *   aktiv:false beantwortet und nicht gemerkt, keine Zustellung.
 * EINSTELLUNGEN: Takt und Menge je Takt wie die Startort-Zustellung (leseStartOrtZustellWerte, PG runtime_ueberwachung).
 * DEBUG: modInboxStand() zeigt gemeldete Identitaeten (Host, Sitzungen, Alter; nie den Ausweis) und den letzten Takt.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { leseStartOrtZustellWerte } from './agent-startort-zustellung.js';
import { fuehreIdentitaetsZustellungAus, leseZustellOptionen, type ZustellErgebnis } from './hauptagent-zustellung.js';

export const MOD_INBOX_FUNKTION = 'mod_inbox' as const;
/** Ohne neue Meldung gilt eine Identitaet nach dieser Zeit als nicht mehr erreichbar (der Daemon meldet alle 15 s). */
const LEBENSZEICHEN_MS = 60_000;

interface Meldung { identity_id: string; project: string; agent_id: string; host: string; sitzungen: Map<string, number> }
const gemeldet = new Map<string, Meldung>();
const laufend = new Set<string>();
let letzterStart = 0;

export interface ModInboxAgent { identity_id: string; agent_id: string; project: string; host: string; ergebnis?: ZustellErgebnis; fehler?: string; uebersprungen?: string }
export interface ModInboxTakt { am: string; kandidaten: number; agenten: ModInboxAgent[] }
let letzter: ModInboxTakt | null = null;

export async function modInboxSchalterAktiv(project: string): Promise<boolean> {
  try { return (await leseProfilProduktSchalter(MOD_INBOX_FUNKTION, project)).aktiv; } catch { return false; }
}

/** Entfernt abgelaufene Sitzungen; true = mindestens eine Sitzung lebt noch. */
function frisch(m: Meldung, jetzt: number): boolean {
  for (const [s, am] of m.sitzungen) if (jetzt - am > LEBENSZEICHEN_MS) m.sitzungen.delete(s);
  return m.sitzungen.size > 0;
}

/**
 * Eine Sitzung mit wartender Mod merken (Aufrufer: Route POST /api/daemon/mod-inbox nach der Ausweispruefung).
 * aktiv = die Identitaet wird ueber die Mod-Inbox beliefert; grund nennt, warum nicht.
 */
export async function meldeModSitzung(e: { host: string; sitzung: string; identity_id: string; jetzt?: number }):
  Promise<{ aktiv: boolean; identity_id: string; agent_id: string | null; grund: string | null }> {
  const r = await getPool().query<{ project: string; agent_id: string; status: string }>(
    'SELECT project, agent_id, status FROM agent_identitaeten WHERE id::text = $1', [e.identity_id]);
  const z = r.rows[0];
  if (!z) return { aktiv: false, identity_id: e.identity_id, agent_id: null, grund: 'identitaet_unbekannt' };
  if (z.status !== 'aktiv') return { aktiv: false, identity_id: e.identity_id, agent_id: z.agent_id, grund: 'identitaet_nicht_aktiv' };
  if (!(await modInboxSchalterAktiv(z.project))) return { aktiv: false, identity_id: e.identity_id, agent_id: z.agent_id, grund: 'schalter_aus' };
  const jetzt = e.jetzt ?? Date.now();
  const alt = gemeldet.get(e.identity_id);
  // Meldet ein anderer PC dieselbe Identitaet, gewinnt die juengste Meldung (die Sitzung laeuft jetzt dort).
  const m: Meldung = alt && alt.host === e.host ? alt
    : { identity_id: e.identity_id, project: z.project, agent_id: z.agent_id, host: e.host, sitzungen: new Map<string, number>() };
  m.project = z.project;
  m.agent_id = z.agent_id;
  m.sitzungen.set(e.sitzung, jetzt);
  gemeldet.set(e.identity_id, m);
  return { aktiv: true, identity_id: e.identity_id, agent_id: z.agent_id, grund: null };
}

/** Ein Takt (manager.ts zustellTakt, ohne await). Wirft nie; je Identitaet nie parallel. */
export async function fuehreModInboxZustellungenAus(jetzt = Date.now()): Promise<ModInboxTakt | null> {
  if (gemeldet.size === 0) return null;
  try {
    const werte = await leseStartOrtZustellWerte(jetzt);
    if (jetzt - letzterStart < werte.takt_ms) return null;
    letzterStart = jetzt;
    const kandidaten = [...gemeldet.values()].filter((m) => {
      if (frisch(m, jetzt)) return true;
      gemeldet.delete(m.identity_id);
      return false;
    });
    const opt = { ...leseZustellOptionen(), aktiv: true };
    const agenten = await Promise.all(kandidaten.map(async (m): Promise<ModInboxAgent> => {
      const basis = { identity_id: m.identity_id, agent_id: m.agent_id, project: m.project, host: m.host };
      if (!(await modInboxSchalterAktiv(m.project))) {
        gemeldet.delete(m.identity_id);
        return { ...basis, uebersprungen: 'schalter_aus' };
      }
      if (laufend.has(m.identity_id)) return { ...basis, uebersprungen: 'laeuft_noch' };
      laufend.add(m.identity_id);
      try {
        const ergebnis = await fuehreIdentitaetsZustellungAus({ identity_id: m.identity_id, project: m.project, agent_id: m.agent_id,
          ziel: { target_hostname: m.host }, optionen: opt, max: werte.je_takt });
        return { ...basis, ergebnis };
      } catch (err) {
        return { ...basis, fehler: ((err as Error).message ?? 'fehler').slice(0, 200) };
      } finally {
        laufend.delete(m.identity_id);
      }
    }));
    letzter = { am: new Date(jetzt).toISOString(), kandidaten: kandidaten.length, agenten };
    return letzter;
  } catch (err) {
    console.error('[mod-inbox] Takt:', (err as Error).message);
    return null;
  }
}

/** Debug: gemeldete Identitaeten (ohne Ausweis) und der letzte Takt. */
export function modInboxStand(jetzt = Date.now()): {
  gemeldet: Array<{ identity_id: string; agent_id: string; project: string; host: string; sitzungen: Array<{ sitzung: string; alter_s: number }> }>;
  letzter_takt: ModInboxTakt | null;
} {
  return {
    gemeldet: [...gemeldet.values()].map((m) => ({ identity_id: m.identity_id, agent_id: m.agent_id, project: m.project, host: m.host,
      sitzungen: [...m.sitzungen].map(([sitzung, am]) => ({ sitzung, alter_s: Math.round((jetzt - am) / 1000) })) })),
    letzter_takt: letzter,
  };
}
