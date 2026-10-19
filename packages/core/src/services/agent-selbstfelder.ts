/**
 * P22-T13 Phase V (K15.5/K16.1): EINE Bedeutungsbeschreibung fuer Selbstidentitaets- und
 * Fachparameter je Tool/Aktion. Sie fasst die bisher in bereiteAgentToolAufrufVor verstreuten
 * Actor-Aliasse zusammen. Tool-spezifische Aliasse gelten nur, wenn die vorhandene Tool-Definition
 * das Feld tatsaechlich anbietet (PA-1, baueErlaubteParameter) - keine dritte unabhaengige
 * Parameterliste. agent_id/role/project sind transportweite Standardfelder.
 *
 * Bedeutungen:
 *  selbst_id          handelnder Agent (agent_id und Actor-Aliasse) - Vergleich mit dem Token (F3)
 *  selbst_rolle       eigene Rolle (role)                             - Vergleich mit dem Token (F3)
 *  selbst_projekt     eigenes Projekt (project)                       - Vergleich in tokenIdentitaet
 *  selbst_beobachtung Selbstauskunft ohne Identitaetswirkung (model bei chat.register/anmelden)
 *  fach               fachlicher Filter/Ziel/Startparameter           - unveraendert, nie verglichen
 * Alles nicht Genannte ist fach, z. B. chat.get.agent_id (Lesefilter), files.history.agent_id
 * (Exaktfilter), docs.source (Quellenkategorie), specialist.spawn.model (Zielmodell), name-Felder.
 * Verschachtelte Selbstfelder ('<liste>[].<feld>', z. B. proposal.create.items[].author) gelten je Element
 * (Paket C): Vergleich je Element mit dem Token (F3), Materialisierung je Element mit dem bestaetigten Actor.
 */
export type SelbstBedeutung = 'selbst_id' | 'selbst_rolle' | 'selbst_projekt' | 'selbst_beobachtung' | 'fach';

export interface SelbstfeldRegel {
  tool: string;
  /** ohne actions: fuer alle Aktionen des Tools */
  actions?: readonly string[];
  feld: string;
  bedeutung: SelbstBedeutung;
}

const STANDARD: Readonly<Record<string, SelbstBedeutung>> = {
  agent_id: 'selbst_id', role: 'selbst_rolle', project: 'selbst_projekt',
};

/** Abweichungen vom Standard und tool-spezifische Actor-Aliasse. Reihenfolge: erste passende Regel gilt. */
export const SELBSTFELD_REGELN: readonly SelbstfeldRegel[] = [
  { tool: 'chat', actions: ['get'], feld: 'agent_id', bedeutung: 'fach' },
  { tool: 'files', actions: ['history'], feld: 'agent_id', bedeutung: 'fach' },
  { tool: 'chat', actions: ['register'], feld: 'id', bedeutung: 'selbst_id' },
  { tool: 'chat', actions: ['register', 'anmelden'], feld: 'model', bedeutung: 'selbst_beobachtung' },
  { tool: 'thought', actions: ['add', 'add_batch'], feld: 'source', bedeutung: 'selbst_id' },
  { tool: 'event', actions: ['emit'], feld: 'source_id', bedeutung: 'selbst_id' },
  { tool: 'chat', actions: ['send'], feld: 'sender_id', bedeutung: 'selbst_id' },
  { tool: 'chat', actions: ['inbox_send'], feld: 'from_agent', bedeutung: 'selbst_id' },
  { tool: 'chat', actions: ['inbox_check'], feld: 'agent_name', bedeutung: 'selbst_id' },
  { tool: 'channel', actions: ['post'], feld: 'sender', bedeutung: 'selbst_id' },
  { tool: 'channel', actions: ['join', 'leave', 'mark_read'], feld: 'agent_name', bedeutung: 'selbst_id' },
  { tool: 'channel', actions: ['create'], feld: 'created_by', bedeutung: 'selbst_id' },
  { tool: 'proposal', actions: ['create'], feld: 'author', bedeutung: 'selbst_id' },
  // P22-T13 Paket C: verschachteltes Selbstfeld der Bulk-Anlage (proposal create items[]).
  { tool: 'proposal', actions: ['create'], feld: 'items[].author', bedeutung: 'selbst_id' },
];

function regelPasst(r: SelbstfeldRegel, tool: string, action: string | undefined, feld: string): boolean {
  return r.tool === tool && r.feld === feld && (!r.actions || (action !== undefined && r.actions.includes(action)));
}

export function feldBedeutung(tool: string, action: string | undefined, feld: string): SelbstBedeutung {
  const r = SELBSTFELD_REGELN.find(x => regelPasst(x, tool, action, feld));
  return r ? r.bedeutung : (STANDARD[feld] ?? 'fach');
}

/** Felder mit Selbstbedeutung fuer diesen Aufruf. Tool-Aliasse nur, wenn die Definition sie anbietet. */
export function selbstFelder(
  tool: string, action: string | undefined, erlaubt?: Set<string>,
): Array<{ feld: string; bedeutung: Exclude<SelbstBedeutung, 'fach'> }> {
  const kandidaten = new Set<string>(Object.keys(STANDARD));
  for (const r of SELBSTFELD_REGELN) if (r.tool === tool && (!erlaubt || erlaubt.has(basisFeld(r.feld)))) kandidaten.add(r.feld);
  const out: Array<{ feld: string; bedeutung: Exclude<SelbstBedeutung, 'fach'> }> = [];
  for (const feld of kandidaten) {
    const b = feldBedeutung(tool, action, feld);
    if (b !== 'fach') out.push({ feld, bedeutung: b });
  }
  return out;
}

export interface Selbstangaben {
  /** ausdruecklich gesendete Selbst-IDs (agent_id und Aliasse) */
  ids: Array<{ feld: string; wert: unknown }>;
  rolle?: { feld: string; wert: unknown };
}

function leer(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

/** Nur AUSDRUECKLICH gesendete Felder; Transport-Vorbelegung gehoert nicht in explizit. */
export function sammleSelbstangaben(
  tool: string, action: string | undefined, explizit: Record<string, unknown>, erlaubt?: Set<string>,
): Selbstangaben {
  const s: Selbstangaben = { ids: [] };
  for (const { feld, bedeutung } of selbstFelder(tool, action, erlaubt)) {
    const v = verschachtelt(feld);
    if (v) {
      const liste = explizit[v.liste];
      if (bedeutung === 'selbst_id' && Array.isArray(liste)) liste.forEach((el, i) => {
        if (el && typeof el === 'object' && Object.hasOwn(el, v.feld) && !leer((el as Record<string, unknown>)[v.feld])) {
          s.ids.push({ feld: `${v.liste}[${i}].${v.feld}`, wert: (el as Record<string, unknown>)[v.feld] });
        }
      });
      continue;
    }
    if (!Object.hasOwn(explizit, feld) || leer(explizit[feld])) continue;
    if (bedeutung === 'selbst_id') s.ids.push({ feld, wert: explizit[feld] });
    else if (bedeutung === 'selbst_rolle') s.rolle = { feld, wert: explizit[feld] };
  }
  return s;
}

/** Feldnamen mit echtem Widerspruch zur bestaetigten Identitaet (keine Werte zurueckspiegeln). */
export function selbstKonflikte(soll: { agent_id: string; rolle: string }, s: Selbstangaben): string[] {
  const felder = s.ids.filter(x => x.wert !== soll.agent_id).map(x => x.feld);
  if (s.rolle && s.rolle.wert !== soll.rolle) felder.push(s.rolle.feld);
  return felder;
}

/** Actor-Aliasse (ohne agent_id/role/project), an die der bestaetigte Actor gebunden wird. */
export function actorAliasFelder(tool: string, action: string | undefined, erlaubt?: Set<string>): string[] {
  return selbstFelder(tool, action, erlaubt)
    .filter(f => f.bedeutung === 'selbst_id' && f.feld !== 'agent_id' && !verschachtelt(f.feld))
    .map(f => f.feld);
}

/** '<liste>[].<feld>' -> Bestandteile; sonst null. */
function verschachtelt(feld: string): { liste: string; feld: string } | null {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\[\]\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(feld);
  return m ? { liste: m[1], feld: m[2] } : null;
}

/** Top-Level-Parameter, den die Tool-Definition anbieten muss (PA-1). */
function basisFeld(feld: string): string {
  return verschachtelt(feld)?.liste ?? feld;
}

/**
 * P22-T13 Paket C: verschachtelte Actor-Felder je Listenelement an den bestaetigten Actor binden (nur unter
 * W1b-Durchsetzung aufgerufen). Neue Elementobjekte, keine Mutation der Originalargumente.
 */
export function bindeVerschachtelteActorFelder(
  tool: string, action: string | undefined, args: Record<string, unknown>, agentId: string, erlaubt?: Set<string>,
): void {
  for (const { feld, bedeutung } of selbstFelder(tool, action, erlaubt)) {
    const v = verschachtelt(feld);
    if (!v || bedeutung !== 'selbst_id' || !Array.isArray(args[v.liste])) continue;
    args[v.liste] = (args[v.liste] as unknown[]).map(el =>
      el && typeof el === 'object' && !Array.isArray(el) ? { ...(el as Record<string, unknown>), [v.feld]: agentId } : el);
  }
}
