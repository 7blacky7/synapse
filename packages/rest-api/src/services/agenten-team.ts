/**
 * P22-T89: Agententeam eines Projekts fuer die Web-UI (GET /api/projects/:name/agenten-team).
 * Abnahme c4df97b2: die Teamansicht las nur wrapper_status (GET specialists); Agenten mit Ausweis fehlten.
 *
 * Nur Lesen aus vorhandenen Vertraegen, keine eigene Erfassung:
 *   Identitaeten     agent_identitaeten des Projekts, status 'aktiv' (archivierte sind 'deaktiviert' und heissen archiv-*),
 *                    ohne Main (der hat sein eigenes Fenster); entfernte nach markiereEntfernteProfile (Schalter agenten_entfernung)
 *   Ausweis          gueltig = ein nicht widerrufener, nicht abgelaufener Eintrag in agent_identitaet_tokens (nie der Wert)
 *   Typ              agent_typen.schluessel des Profils
 *   Lauf             Status des juengsten Laufs (agent_identitaet_laeufe)
 *   letzte Anmeldung leseAnmeldungen (P22-T87, nur_letzte) - nur wenn der Produkt-Schalter agent_anmeldungen EIN ist;
 *                    sonst null und anmeldungen.aktiv=false in der Antwort
 *   Kontext          aus der Anmeldung (hauptagent_verlauf bzw. wrapper_status des aktiven Laufs), sonst wrapper_status der Zeile
 *   Ort              ermittleAgentHerkunft (wie die Channel-Teilnehmer)
 *   Wrapper          listWrapperStatus wie GET specialists; Zeilen mit dem agent_id einer Identitaet haengen an ihr,
 *                    die uebrigen erscheinen als eigene Eintraege (art 'wrapper'); archiv-* und entfernte bleiben draussen
 */
import {
  ermittleAgentHerkunft,
  getPool,
  kennzeichnung,
  leseAnmeldungen,
  leseAnmeldungenSchalter,
  listWrapperStatus,
  markiereEntfernteProfile,
  ohneEntfernte,
  waehleSpezialisten,
} from '@synapse/core';

type Zeit = { iso: string; ortszeit: string } | null;

export interface TeamWrapper {
  status: string;
  busy: boolean;
  current_task: string | null;
  channels: string[];
  tokens: { input: number; output: number; percent: number };
  model: string | null;
  provider: string | null;
  last_activity: string;
  verwaist?: boolean;
  inaktiv_seit?: string | null;
}

export interface TeamAgent {
  schluessel: string;
  art: 'identitaet' | 'wrapper';
  name: string;
  agent_id: string;
  identity_id: string | null;
  rolle: string | null;
  typ: string | null;
  modell: string | null;
  ausweis: 'gueltig' | 'keiner' | null;
  zuletzt_aktiv: string | null;
  /** Status des juengsten Laufs (agent_identitaet_laeufe), unabhaengig vom Schalter agent_anmeldungen. */
  lauf_status: string | null;
  letzte_anmeldung: { zeit: Zeit; anlass: string | null; aufruf: string | null; lauf_status: string | null; ort: string | null } | null;
  kontext: Record<string, unknown> | null;
  herkunft: { art: string; ort: string | null; quelle: string | null };
  wrapper: TeamWrapper | null;
}

interface IdentZeile {
  identity_id: string; agent_id: string; name: string; rolle: string; modell: string | null; typ: string | null;
  zuletzt_aktiv: Date | null; lauf_status: string | null; ausweis_gueltig: boolean;
}

const IDENT_SQL = `
SELECT i.id AS identity_id, i.agent_id, i.name, i.rolle, COALESCE(i.modell_bestaetigt, i.modell_selbstauskunft) AS modell,
       t.schluessel AS typ, i.zuletzt_aktiv,
       (SELECT l.status FROM agent_identitaet_laeufe l WHERE l.identity_id = i.id ORDER BY l.context_epoch DESC LIMIT 1) AS lauf_status,
       EXISTS (SELECT 1 FROM agent_identitaet_tokens k
                WHERE k.identity_id = i.id AND k.widerrufen_am IS NULL AND (k.gueltig_bis IS NULL OR k.gueltig_bis > NOW())) AS ausweis_gueltig
  FROM agent_identitaeten i
  LEFT JOIN agent_typen t ON t.id = i.typ_id
 WHERE i.project = $1 AND i.status = 'aktiv' AND ($2::boolean OR i.rolle <> 'main') AND i.agent_id NOT LIKE 'archiv-%'
 ORDER BY i.zuletzt_aktiv DESC NULLS LAST, i.name`;

function wrapperAus(row: Awaited<ReturnType<typeof listWrapperStatus>>[number], kennz: Record<string, unknown>): TeamWrapper {
  return {
    ...kennz,
    status: row.status,
    busy: row.busy ?? false,
    current_task: row.currentTask ?? null,
    channels: row.channels ?? [],
    tokens: { input: row.tokensInput ?? 0, output: row.tokensOutput ?? 0, percent: row.tokensPercent ?? 0 },
    model: row.modelFullId ?? row.model ?? null,
    provider: row.provider ?? null,
    last_activity: row.lastActivity.toISOString(),
  };
}

function wrapperKontext(w: TeamWrapper | null): Record<string, unknown> | null {
  return w ? { quelle: 'wrapper_status', stand: 'aktuell', prozent: w.tokens.percent, tokens: w.tokens.input, modell: w.model } : null;
}

export async function ladeAgentenTeam(project: string, optionen: { hauptagent?: boolean } = {}): Promise<Record<string, unknown>> {
  const ident = await markiereEntfernteProfile(project, (await getPool().query<IdentZeile>(IDENT_SQL, [project, optionen.hauptagent === true])).rows, false);

  const auswahl = waehleSpezialisten(await listWrapperStatus(project), { alle: true });
  const wrapperZeilen = await ohneEntfernte(project, auswahl.sichtbar.filter((z) => !z.row.agentName.startsWith('archiv-')),
    (z) => ({ agent: z.row.agentName }));
  const wrapper = new Map(wrapperZeilen.map((z) => [z.row.agentName, wrapperAus(z.row, kennzeichnung(z))]));

  const schalter = await leseAnmeldungenSchalter(project);
  const anmeldung = new Map<string, Record<string, unknown>>();
  let anmeldungFehler: string | null = null;
  if (schalter.aktiv && ident.length) {
    try {
      const r = await leseAnmeldungen({ project, nur_letzte: true, weg: 'ausweis' });
      for (const z of (r.anmeldungen as Array<Record<string, unknown>>)) {
        if (typeof z.identity_id === 'string' && !anmeldung.has(z.identity_id)) anmeldung.set(z.identity_id, z);
      }
    } catch (err) {
      anmeldungFehler = ((err as { message?: string } | null)?.message ?? 'anmeldungen_fehler').slice(0, 120);
    }
  }

  // Wrapper-Zeilen einer Identitaet werden VOR dem ersten await entnommen; was bleibt, sind Spezialisten ohne Ausweis.
  const agenten: TeamAgent[] = await Promise.all(ident.map(async (i) => {
    const w = wrapper.get(i.agent_id) ?? null;
    wrapper.delete(i.agent_id);
    const a = anmeldung.get(i.identity_id);
    const kontext = a?.kontext && (a.kontext as { quelle?: string }).quelle !== 'nicht_verfuegbar' ? a.kontext as Record<string, unknown> : wrapperKontext(w);
    const h = await ermittleAgentHerkunft(project, { agent: i.agent_id, identity_id: i.identity_id });
    return {
      schluessel: 'identity:' + i.identity_id, art: 'identitaet', name: i.name, agent_id: i.agent_id, identity_id: i.identity_id,
      rolle: i.rolle, typ: i.typ, modell: i.modell ?? w?.model ?? null, ausweis: i.ausweis_gueltig ? 'gueltig' : 'keiner',
      zuletzt_aktiv: i.zuletzt_aktiv ? i.zuletzt_aktiv.toISOString() : null, lauf_status: i.lauf_status,
      letzte_anmeldung: a ? {
        zeit: (a.zeit as Zeit) ?? null, anlass: typeof a.anlass === 'string' ? a.anlass : null, aufruf: typeof a.aufruf === 'string' ? a.aufruf : null,
        lauf_status: typeof a.lauf_status === 'string' ? a.lauf_status : null, ort: typeof a.ort === 'string' ? a.ort : null,
      } : null,
      kontext, herkunft: h, wrapper: w,
    };
  }));
  const nurWrapper: TeamAgent[] = await Promise.all([...wrapper.entries()].map(async ([name, w]) => ({
    schluessel: 'wrapper:' + name, art: 'wrapper' as const, name, agent_id: name, identity_id: null, rolle: null, typ: null,
    modell: w.model, ausweis: null, zuletzt_aktiv: w.last_activity, lauf_status: null, letzte_anmeldung: null, kontext: wrapperKontext(w),
    herkunft: await ermittleAgentHerkunft(project, { agent: name }), wrapper: w,
  })));

  return {
    success: true,
    project,
    agenten: [...agenten, ...nurWrapper],
    anzahl: { identitaeten: agenten.length, nur_wrapper: nurWrapper.length },
    anmeldungen: { aktiv: schalter.aktiv, quelle: schalter.quelle, ...(anmeldungFehler ? { letzter_fehler: anmeldungFehler } : {}) },
    quellen: {
      identitaeten: 'agent_identitaeten (status aktiv, ohne Main und archiv-*)',
      ausweis: 'agent_identitaet_tokens (gueltig ja/nein, nie der Wert)',
      letzte_anmeldung: 'admin anmeldungen (leseAnmeldungen, nur_letzte; Schalter agent_anmeldungen)',
      kontext: 'Anmeldung (hauptagent_verlauf/wrapper_status), sonst wrapper_status',
      herkunft: 'ermittleAgentHerkunft',
      wrapper: 'wrapper_status wie GET specialists',
    },
  };
}
