/**
 * P22-T105 (Erweiterung P22-T26): Ausweis-Channels. EINE Lesestelle fuer die Channels aus dem Ausweis (Profil oder Typ), genutzt
 * von der Anmeldung (agent-profil-update.ts baueFortsetzungsErgaenzung), dem Abgleich je Tool-Aufruf (tool-antwort.ts
 * ergaenzeToolHinweise, VOR dem unread-Claim) und channel leave (channels.ts leaveChannel).
 *
 * USER-VORGABE 21.10.2026: Kommt ein Channel in den Ausweis, tritt die Identitaet ihm SOFORT und STILL bei, auch im laufenden Lauf
 *   (kein Join-Hinweis, ab dem naechsten Aufruf nur unread_channels). NUR ADDITIV: der Abgleich loescht nie eine Mitgliedschaft.
 *   Steht ein Channel im Ausweis, wird channel leave abgewiesen (CHANNEL_IM_AUSWEIS_FEHLER); selbst beigetretene Channels und
 *   aus dem Ausweis entfernte Channels sind jederzeit verlassbar (Mitgliedschaft bleibt bis dahin bestehen).
 * WIRKSAME AUSWEIS-CHANNELS: Feld channels des Profil-Overrides (agent_identitaeten.profil), sonst des Typs, sonst des gleichnamigen
 *   globalen Typs (gleiche Vererbung je Top-Level-Feld wie leseWirksamesProfil). TYP-PINNING (26cf1837 B3): Fuer die Channels gilt
 *   IMMER die AKTUELLE Typrevision (agent_typen.aktuelle_revision), nicht die bei der Zuweisung gepinnte agent_identitaeten.typ_revision.
 *   Alle anderen Felder (Regeln, Zuschnitt, Kontext ...) bleiben gepinnt, bis der Typ erneut zugewiesen wird (Profilrevision + Hinweis
 *   w1b.profil_update). Grund: Channels wirken nur additiv und sind der Weg, Anweisungen zuzustellen.
 * LESESTAND: Beim Anmelden wie channel(join) ab jetzt. Im laufenden Lauf ab dem Stand des Ausweises (juengste Profil- bzw.
 *   Typrevision), damit Posts zwischen Ausweisaenderung und naechstem Aufruf als ungelesen erscheinen.
 * SCHALTER 'ausweis_channels' (regel-neue-funktionen-mit-schalter-und-debug): Produkt-Schalter (I) im Katalog
 *   PROFIL_PRODUKT_FUNKTIONEN, nur ausdruecklich, Standard AUS bis Abnahme; wirksam = intern-Override 'ausweis_channels' (nur
 *   SYNAPSE_INTERN_TOOL=1, befristet) > Produkt-Schalter (projekt > global) > Standard AUS. AUS = P22-T26-Verhalten (Profil-Channels
 *   nur beim Zustellen des Profilblocks, leave unbeschraenkt). Puffer je Prozess wie der Ausweis-Kern (SYNAPSE_W1B_GATE_TTL_MS).
 * DEBUG: leseAusweisChannelsSchalter() (Quelle, bis, letzter_fehler), leseAusweisChannels() (Channels, Herkunft, Typrevision, Stand).
 */
import type { QueryConfig } from 'pg';
import { getPool } from '../db/client.js';
import { aktuellerAgentPrincipal, type IdentitaetsAgentPrincipal } from './agent-bezug.js';
import { kernTtlMs, leseProfilProduktSchalter, registriereSchalterGeschrieben } from './agent-profil-schalter.js';

export const AUSWEIS_CHANNELS_FUNKTION = 'ausweis_channels' as const;
export const CHANNEL_IM_AUSWEIS_FEHLER = 'channel_im_ausweis_festgelegt' as const;

type Q = QueryConfig & { query_timeout: number };
const istObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : null);

export class AusweisChannelFehler extends Error {
  readonly code = CHANNEL_IM_AUSWEIS_FEHLER;
  constructor(public readonly channel: string) {
    super(`${CHANNEL_IM_AUSWEIS_FEHLER}: Channel "${channel}" steht in deinem Ausweis und kann nicht verlassen werden. `
      + 'Aendern nur Koordinator/User ueber das Profil (Ausweis-Channels).');
  }
}

// ---------------------------------------------------------------------------------------------
// Schalter
// ---------------------------------------------------------------------------------------------
export interface AusweisChannelsSchalter {
  aktiv: boolean;
  project: string | null;
  quelle: 'standard' | 'produkt-schalter' | 'intern';
  bis: string | null;
  letzter_fehler: string | null;
}

const PUFFER = new Map<string, { bis: number; stand: AusweisChannelsSchalter }>();
/** Puffer verwerfen (Tests; automatisch nach jedem Schreiben eines Produkt-Schalters im eigenen Prozess). */
export function leereAusweisChannelsPuffer(): void { PUFFER.clear(); }
registriereSchalterGeschrieben(leereAusweisChannelsPuffer);

async function leseSchalterFrisch(project: string | null): Promise<AusweisChannelsSchalter> {
  const basis: AusweisChannelsSchalter = { aktiv: false, project, quelle: 'standard', bis: null, letzter_fehler: null };
  let letzter: string | null = null;
  try {
    // Dynamisch wie chat-ausweis-lesen.ts (Importzyklus ueber intern-tool).
    const { internToolAktiv } = await import('./intern-tool.js');
    if (internToolAktiv()) {
      try {
        const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
          text: `SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
          values: [AUSWEIS_CHANNELS_FUNKTION], query_timeout: 2000,
        } as Q);
        const z = r.rows[0];
        if (z) return { ...basis, aktiv: z.aktiv, quelle: 'intern', bis: z.bis ? z.bis.toISOString() : null };
      } catch { letzter = 'schalter_nicht_erreichbar'; }
    }
    const p = await leseProfilProduktSchalter(AUSWEIS_CHANNELS_FUNKTION, project);
    if (p.quelle === 'produkt-schalter') return { ...basis, aktiv: p.aktiv, quelle: 'produkt-schalter', letzter_fehler: letzter };
    return { ...basis, letzter_fehler: letzter ?? p.letzter_fehler };
  } catch {
    return { ...basis, letzter_fehler: 'schalter_nicht_lesbar' };
  }
}

/** Wirksamer Schalter je Projekt; Lesefehler -> Standard AUS mit letzter_fehler. Wirft nie. */
export async function leseAusweisChannelsSchalter(project: string | null): Promise<AusweisChannelsSchalter> {
  const ttl = kernTtlMs();
  const schluessel = project ?? '';
  const jetzt = Date.now();
  const c = ttl > 0 ? PUFFER.get(schluessel) : undefined;
  if (c && c.bis > jetzt) return c.stand;
  const stand = await leseSchalterFrisch(project);
  if (ttl > 0 && !stand.letzter_fehler) PUFFER.set(schluessel, { bis: jetzt + ttl, stand });
  return stand;
}

// ---------------------------------------------------------------------------------------------
// Lesestelle
// ---------------------------------------------------------------------------------------------
export interface AusweisChannels {
  identity_id: string;
  project: string;
  channels: string[];
  herkunft: 'profil' | 'projekt_typ' | 'global_typ' | null;
  /** Aktuelle (ungepinnte) Typrevision, aus der die Channels stammen koennen. */
  typ_revision: number | null;
  /** Juengste Profil- bzw. Typrevision: ab hier zaehlen Posts im laufenden Lauf als ungelesen. */
  stand: Date | null;
}

const AUSWEIS_CHANNELS_SQL = `SELECT i.project, i.profil, t.scope, t.aktuelle_revision, tr.inhalt AS typ_inhalt, gr.inhalt AS global_inhalt,
    GREATEST(pr.wann, tr.wann, gr.wann) AS stand
  FROM agent_identitaeten i
  LEFT JOIN agent_typen t ON t.id = i.typ_id
  LEFT JOIN agent_typ_revisionen tr ON tr.typ_id = t.id AND tr.revision = t.aktuelle_revision
  LEFT JOIN agent_typen g ON t.scope = 'projekt' AND g.scope = 'global' AND g.schluessel = t.schluessel AND g.status = 'aktiv'
  LEFT JOIN agent_typ_revisionen gr ON gr.typ_id = g.id AND gr.revision = g.aktuelle_revision
  LEFT JOIN agent_profil_revisionen pr ON pr.identity_id = i.id AND pr.revision = i.profil_revision
  WHERE i.id = $1`;

/** EINE Lesestelle fuer Anmeldung, laufenden Lauf und leave (unabhaengig vom Schalter; die Aufrufer pruefen ihn). */
export async function leseAusweisChannels(identity_id: string): Promise<AusweisChannels | null> {
  const r = await getPool().query<{ project: string; profil: unknown; scope: string | null; aktuelle_revision: number | null;
    typ_inhalt: unknown; global_inhalt: unknown; stand: Date | null }>({ text: AUSWEIS_CHANNELS_SQL, values: [identity_id], query_timeout: 2000 } as Q);
  const z = r.rows[0];
  if (!z) return null;
  const aus = (quelle: unknown): string[] | null => (istObj(quelle) ? strList(quelle.channels) : null);
  const profil = aus(z.profil), typ = aus(z.typ_inhalt), global = aus(z.global_inhalt);
  const [channels, herkunft]: [string[], AusweisChannels['herkunft']] = profil ? [profil, 'profil']
    : typ ? [typ, z.scope === 'global' ? 'global_typ' : 'projekt_typ'] : global ? [global, 'global_typ'] : [[], null];
  return { identity_id, project: z.project, channels: [...new Set(channels)], herkunft,
    typ_revision: z.aktuelle_revision ?? null, stand: z.stand ?? null };
}

// ---------------------------------------------------------------------------------------------
// Abgleich (nur additiv)
// ---------------------------------------------------------------------------------------------
export interface AusweisChannelAbgleich {
  channels: string[];
  /** Ausweis-Channels, in denen die Identitaet nach dem Abgleich Mitglied ist (auch vorher schon). */
  mitglied: string[];
  /** In diesem Abgleich neu beigetreten. */
  neu: string[];
  /** Channel existiert (noch) nicht im Projekt oder Beitritt gescheitert. */
  fehlend: string[];
}

/**
 * Traegt fehlende Ausweis-Channels nach (wie channel join, still). Ohne Schalter null (Aufrufer behalten ihr Altverhalten).
 * lesestand 'jetzt' = Anmeldung; 'seit_ausweis' = laufender Lauf (Posts seit der Ausweisaenderung zaehlen als ungelesen).
 */
export async function gleicheAusweisChannelsAb(p: IdentitaetsAgentPrincipal, opt: { lesestand: 'jetzt' | 'seit_ausweis' }): Promise<AusweisChannelAbgleich | null> {
  if (!(await leseAusweisChannelsSchalter(p.project)).aktiv) return null;
  const a = await leseAusweisChannels(p.identity_id);
  const out: AusweisChannelAbgleich = { channels: a?.channels ?? [], mitglied: [], neu: [], fehlend: [] };
  if (!a || a.project !== p.project || a.channels.length === 0) return out;
  const r = await getPool().query<{ name: string; vorhanden: boolean; mitglied: boolean }>({
    text: `SELECT x.name, c.id IS NOT NULL AS vorhanden,
        (EXISTS (SELECT 1 FROM agent_identitaet_channel_mitglieder m WHERE m.channel_id = c.id AND m.identity_id = $3)
         OR EXISTS (SELECT 1 FROM specialist_channel_members s WHERE s.channel_id = c.id AND s.agent_name = $4)) AS mitglied
      FROM unnest($2::text[]) AS x(name)
      LEFT JOIN specialist_channels c ON c.project = $1 AND c.name = x.name`,
    values: [p.project, a.channels, p.identity_id, p.agent_id], query_timeout: 2000,
  } as Q);
  const { joinChannel } = await import('./channels.js');
  for (const z of r.rows) {
    if (z.mitglied) { out.mitglied.push(z.name); continue; }
    if (!z.vorhanden) { out.fehlend.push(z.name); continue; }
    try {
      const ok = await joinChannel(p.project, z.name, { art: 'identity', project: p.project, agent_id: p.agent_id, identity_id: p.identity_id },
        { lesestandBis: opt.lesestand === 'seit_ausweis' ? a.stand : null });
      if (ok) { out.mitglied.push(z.name); out.neu.push(z.name); } else out.fehlend.push(z.name);
    } catch { out.fehlend.push(z.name); }
  }
  return out;
}

/** Abgleich im laufenden Lauf (ergaenzeToolHinweise): nur mit Ausweis-Principal derselben Agent-ID; still, wirft nie. */
export async function gleicheAusweisChannelsImAufrufAb(agentId: string): Promise<void> {
  const p = aktuellerAgentPrincipal();
  if (!p || p.art !== 'identity' || p.agent_id !== agentId) return;
  try {
    await gleicheAusweisChannelsAb(p, { lesestand: 'seit_ausweis' });
  } catch (e) {
    console.error('[AusweisChannels] Abgleich fehlgeschlagen:', e instanceof Error ? e.message : e);
  }
}

/** leave-Sperre: wirft AusweisChannelFehler, wenn der Channel in den wirksamen Ausweis-Channels steht (nur mit Schalter). */
export async function pruefeAusweisChannelVerlassen(project: string, channelName: string, identity_id: string): Promise<void> {
  if (!(await leseAusweisChannelsSchalter(project)).aktiv) return;
  const a = await leseAusweisChannels(identity_id);
  if (a && a.project === project && a.channels.includes(channelName)) throw new AusweisChannelFehler(channelName);
}
