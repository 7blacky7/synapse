/**
 * P22-T134 (User 25.10.2026): Mod-Inbox. Interaktive Claude-Code-Sitzungen am PC ohne Wrapper (Koordinator-CLI, Subagent mit
 * Ausweis; start_ort extern) bekommen Nachrichten ueber den lokalen Daemon: eine Claude-Code-Mod in der Sitzung wartet am Daemon
 * und startet mit $.prompt.submit einen Turn (Beleg thought 5b2efc34). Ersetzt cc-wrap/cc-send, auch wenn der User nicht da ist.
 * ABLAUF: Der Daemon meldet je Takt die Sitzungen mit wartender Mod (POST /api/daemon/mod-inbox, Ausweis aus dem Transcript
 *   wie cli-verlauf). Die API merkt sich Identitaet -> Host im Speicher (Lebenszeichen wie daemon-bruecke, kein PG; nach einem
 *   API-Neustart meldet der Daemon im naechsten Takt neu). Der Zustell-Takt (agent-runtime/manager.ts) stellt jeder frisch
 *   gemeldeten Identitaet ueber fuehreIdentitaetsZustellungAus mit target_hostname zu: gleicher Ledger, Wasserstand und
 *   dieselbe Quittung wie P22-T113. Der Daemon fuehrt 'zustellen' ohne Wrapper ueber die Mod aus (mod-inbox.ts im Daemon).
 * P22-T144 (Befund thought 8ec16245, Fehlerfix OHNE Schalter): Die Mod antwortet nach hoechstens 20 s (UEBERGABE_FRIST_MS im
 *   Daemon), deshalb wartet dieser Weg nur MOD_TURN_WARTE_MS statt der Turnfrist des Wrappers (10 min). Meldet ein Host eine neue
 *   daemon_id, gibt die API noch laufende Zustell-Jobs des alten Daemons frei (failed 'daemon_neugestartet') und macht die
 *   wartenden Ledger-Zeilen sofort faellig: nach einem Daemon-Neustart Sekunden statt Minuten.
 * P22-T151 (Doppelzustellung inbox:1100, thought e228002f): Die Mod meldet 'angenommen' sofort beim Empfang und fragt weiter ab.
 *   Der Daemon antwortet dann 'uebergeben_wartet'; hauptagent-zustellung.ts zaehlt das nicht als Versuch und gibt die folgenden
 *   Nachrichten im selben Takt weiter. Eine angenommene Nachricht wird nie zweimal uebergeben und nie 'fehler'.
 * P22-T144 Quittung (Schalter inbox_quittung, inbox-quittung.ts): Neuanmeldung = neue daemon_id oder eine bisher unbekannte
 *   Sitzung einer schon gemeldeten Identitaet. Danach stellt der naechste Takt genau EINE Erinnerung mit den offenen
 *   Quittungs-IDs zu (Absender system, kein Inhalt). Nach einem API-Neustart (Identitaet noch unbekannt) keine Erinnerung.
 * SCHALTER: Produkt-Schalter mod_inbox (je Projekt/global, Standard AUS, nur ausdruecklich). AUS = Meldungen werden mit
 *   aktiv:false beantwortet und nicht gemerkt, keine Zustellung.
 * EINSTELLUNGEN: Takt und Menge je Takt wie die Startort-Zustellung (leseStartOrtZustellWerte, PG runtime_ueberwachung).
 * DEBUG: modInboxStand() zeigt gemeldete Identitaeten (Host, Daemon, Sitzungen, Alter; nie den Ausweis), offene Quittungen,
 *   Erinnerung und Daemon-Wechsel sowie den letzten Takt.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { leseStartOrtZustellWerte } from './agent-startort-zustellung.js';
import { fuehreIdentitaetsZustellungAus, leseZustellOptionen, type ZustellErgebnis } from './hauptagent-zustellung.js';
import { gibVerwaisteZustellJobsFrei } from './specialist-queue.js';
import { inboxQuittungAktiv, offeneQuittungen, stelleErinnerungZu, type ErinnerungErgebnis } from './inbox-quittung.js';

export const MOD_INBOX_FUNKTION = 'mod_inbox' as const;
/** Ohne neue Meldung gilt eine Identitaet nach dieser Zeit als nicht mehr erreichbar (der Daemon meldet alle 15 s). */
const LEBENSZEICHEN_MS = 60_000;
/** P22-T144: Wartezeit je Zustell-Job auf diesem Weg (Daemon-Frist 20 s plus Luft), statt der Turnfrist des Wrappers. */
export const MOD_TURN_WARTE_MS = 45_000;
/** So viele Sitzungs-IDs je Identitaet bleiben bekannt (Erkennung einer neuen Sitzung). */
const BEKANNT_MAX = 50;

interface Meldung {
  identity_id: string; project: string; agent_id: string; host: string; sitzungen: Map<string, number>;
  daemon_id: string | null; bekannt: Set<string>; erinnerung_faellig: boolean;
  /** Zeitpunkt der Neuanmeldung: die Erinnerung nennt nur Zustellungen davor (neue kamen schon in die neue Sitzung). */
  erinnerung_bis: Date | null;
  erinnerung_letzte: (ErinnerungErgebnis & { am: string }) | null;
  daemon_wechsel_letzter: { am: string; von: string | null; nach: string; freigegeben: string[] } | null;
  offene_quittungen: { anzahl: number; aelteste_s: number | null } | null;
}
const gemeldet = new Map<string, Meldung>();
const laufend = new Set<string>();
let letzterStart = 0;

export interface ModInboxAgent { identity_id: string; agent_id: string; project: string; host: string; ergebnis?: ZustellErgebnis; erinnerung?: ErinnerungErgebnis; fehler?: string; uebersprungen?: string }
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

function merkeBekannt(m: Meldung, sitzung: string): void {
  m.bekannt.delete(sitzung);
  m.bekannt.add(sitzung);
  while (m.bekannt.size > BEKANNT_MAX) m.bekannt.delete(m.bekannt.values().next().value as string);
}

/**
 * P22-T144: Daemon-Wechsel auf dem Host. Zustell-Jobs, die ein anderer Daemon dieses Hosts geclaimt hat, freigeben und die
 * wartenden Ledger-Zeilen sofort faellig machen. Wirft nie (Zustellung bleibt sonst beim alten Backoff).
 */
async function raeumeDaemonWechsel(m: Meldung, daemonId: string, von: string | null): Promise<void> {
  let freigegeben: string[] = [];
  try {
    freigegeben = await gibVerwaisteZustellJobsFrei(m.identity_id, m.host, daemonId);
    await getPool().query("UPDATE agent_zustellungen SET naechster_versuch=NOW() WHERE identity_id=$1 AND status='pending' AND naechster_versuch>NOW()", [m.identity_id]);
  } catch (err) {
    console.error('[mod-inbox] Daemon-Wechsel:', (err as Error).message);
  }
  m.daemon_wechsel_letzter = { am: new Date().toISOString(), von, nach: daemonId, freigegeben };
}

/**
 * Eine Sitzung mit wartender Mod merken (Aufrufer: Route POST /api/daemon/mod-inbox nach der Ausweispruefung).
 * aktiv = die Identitaet wird ueber die Mod-Inbox beliefert; grund nennt, warum nicht. offene_quittungen nur bei Schalter
 * inbox_quittung (Debug im Daemon-Status).
 */
export async function meldeModSitzung(e: { host: string; sitzung: string; identity_id: string; daemon_id?: string | null; jetzt?: number }):
  Promise<{ aktiv: boolean; identity_id: string; agent_id: string | null; grund: string | null; offene_quittungen?: { anzahl: number; aelteste_s: number | null } }> {
  const r = await getPool().query<{ project: string; agent_id: string; status: string }>(
    'SELECT project, agent_id, status FROM agent_identitaeten WHERE id::text = $1', [e.identity_id]);
  const z = r.rows[0];
  if (!z) return { aktiv: false, identity_id: e.identity_id, agent_id: null, grund: 'identitaet_unbekannt' };
  if (z.status !== 'aktiv') return { aktiv: false, identity_id: e.identity_id, agent_id: z.agent_id, grund: 'identitaet_nicht_aktiv' };
  if (!(await modInboxSchalterAktiv(z.project))) return { aktiv: false, identity_id: e.identity_id, agent_id: z.agent_id, grund: 'schalter_aus' };
  const jetzt = e.jetzt ?? Date.now();
  const alt = gemeldet.get(e.identity_id);
  const daemonId = e.daemon_id ?? null;
  // Meldet ein anderer PC dieselbe Identitaet, gewinnt die juengste Meldung (die Sitzung laeuft jetzt dort).
  const m: Meldung = alt && alt.host === e.host ? alt
    : { identity_id: e.identity_id, project: z.project, agent_id: z.agent_id, host: e.host, sitzungen: new Map<string, number>(),
      daemon_id: null, bekannt: new Set<string>(), erinnerung_faellig: false, erinnerung_bis: null, erinnerung_letzte: alt?.erinnerung_letzte ?? null,
      daemon_wechsel_letzter: alt?.daemon_wechsel_letzter ?? null, offene_quittungen: null };
  m.project = z.project;
  m.agent_id = z.agent_id;
  const neueSitzung = !m.bekannt.has(e.sitzung);
  const neuerDaemon = daemonId !== null && m.daemon_id !== daemonId;
  if (neuerDaemon) {
    const von = m.daemon_id;
    m.daemon_id = daemonId;
    await raeumeDaemonWechsel(m, daemonId, von);
  }
  // Erinnerung nur bei einer Neuanmeldung einer schon bekannten Identitaet (nicht nach einem API-Neustart).
  if (alt && (neuerDaemon || neueSitzung)) { m.erinnerung_faellig = true; m.erinnerung_bis = new Date(); }
  m.sitzungen.set(e.sitzung, jetzt);
  merkeBekannt(m, e.sitzung);
  gemeldet.set(e.identity_id, m);
  if (await inboxQuittungAktiv(z.project)) {
    try {
      const o = await offeneQuittungen(e.identity_id, 1, jetzt);
      m.offene_quittungen = { anzahl: o.anzahl, aelteste_s: o.aelteste_s };
    } catch { m.offene_quittungen = null; }
  } else m.offene_quittungen = null;
  return { aktiv: true, identity_id: e.identity_id, agent_id: z.agent_id, grund: null, ...(m.offene_quittungen ? { offene_quittungen: m.offene_quittungen } : {}) };
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
    const opt = { ...leseZustellOptionen(), aktiv: true, turn_warte_ms: MOD_TURN_WARTE_MS };
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
        // P22-T144: nach den neuen Nachrichten genau eine Erinnerung an offene Quittungen (nur Schalter inbox_quittung).
        let erinnerung: ErinnerungErgebnis | undefined;
        if (m.erinnerung_faellig) {
          if (!(await inboxQuittungAktiv(m.project))) m.erinnerung_faellig = false;
          else {
            erinnerung = await stelleErinnerungZu({ identity_id: m.identity_id, project: m.project, agent_id: m.agent_id,
              ziel: { target_hostname: m.host }, warte_ms: MOD_TURN_WARTE_MS, jetzt, bis: m.erinnerung_bis });
            m.erinnerung_letzte = { ...erinnerung, am: new Date(jetzt).toISOString() };
            if (erinnerung.erledigt) m.erinnerung_faellig = false;
          }
        }
        return { ...basis, ergebnis, ...(erinnerung ? { erinnerung } : {}) };
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
  gemeldet: Array<{ identity_id: string; agent_id: string; project: string; host: string; daemon_id: string | null;
    sitzungen: Array<{ sitzung: string; alter_s: number }>; offene_quittungen: Meldung['offene_quittungen'];
    erinnerung_faellig: boolean; erinnerung_letzte: Meldung['erinnerung_letzte']; daemon_wechsel_letzter: Meldung['daemon_wechsel_letzter'] }>;
  letzter_takt: ModInboxTakt | null;
} {
  return {
    gemeldet: [...gemeldet.values()].map((m) => ({ identity_id: m.identity_id, agent_id: m.agent_id, project: m.project, host: m.host,
      daemon_id: m.daemon_id, sitzungen: [...m.sitzungen].map(([sitzung, am]) => ({ sitzung, alter_s: Math.round((jetzt - am) / 1000) })),
      offene_quittungen: m.offene_quittungen, erinnerung_faellig: m.erinnerung_faellig, erinnerung_letzte: m.erinnerung_letzte,
      daemon_wechsel_letzter: m.daemon_wechsel_letzter })),
    letzter_takt: letzter,
  };
}

/** Nur fuer Tests: gemerkten Zustand verwerfen (wie ein API-Neustart). */
export function vergesseModInboxStand(): void {
  gemeldet.clear();
  laufend.clear();
  letzterStart = 0;
  letzter = null;
}
