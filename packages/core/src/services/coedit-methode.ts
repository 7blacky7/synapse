/**
 * P22-T199 (Entwurf 7efece9b, Freigabe bf31526a): EINE Lesestelle der Co-Edit-Methode.
 *
 * SCHALTER: Produkt-Schalter 'coedit_ohne_gate' (agent_profil_schalter, projekt > global, Standard AUS, nur ausdruecklich;
 *   setzen User/Koordinator ueber admin profil_schalter_setzen) mit befristetem intern-Override gleichen Namens (nur bei
 *   aktivem intern-Tool, modus 'freigegeben'; regel-neue-funktionen-mit-schalter-und-debug).
 *   AUS (Standard) = Ready-Gate wie bisher (Entscheidung ea8b62c0, T198-Stand): commit eines gemeinsamen Plans wartet auf
 *     aktive Beitragende (Frist coedit_aktiv_sekunden, agent-ausweis-fristen.ts).
 *   EIN = ohne Gate: jede Op wird im Schatten geprueft (gueltig | fehlerhaft | konflikt | drift), commit schreibt alle in
 *     diesem Moment gueltigen Ops atomar, kein ready, kein Warten; der Plan bleibt mit derselben plan_id offen.
 *   Gilt nur fuer gemeinsame Plaene mit mehreren Autoren (E1); Plaene mit einem Autor bleiben atomar.
 * LESEN: je files-Aufruf, daher gepuffert (kernTtlMs) ueber leseProfilProduktSchalterGepuffert; der intern-Override wird nur
 *   mit aktivem intern-Tool gelesen. Lesefehler -> der zuletzt fehlerfrei gelesene Wert dieses Projekts gilt noch bis
 *   LETZTER_WERT_HALTEN_MS weiter (t215: unter Last liefen sonst einzelne Aufrufe eines EIN-Projekts per query_timeout auf
 *   ready_gate), ohne solchen Wert ready_gate (Altverhalten); letzter_fehler bleibt sichtbar. Wirft nie.
 * DEBUG: Stand mit wirksam, quelle (standard | produkt-schalter | intern), ebene, bis, letzter_fehler.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalterGepuffert, type ProfilProduktSchalterStand } from './agent-profil-schalter.js';
import { internToolAktiv } from './intern-tool-aktiv.js';

export const COEDIT_OHNE_GATE_FUNKTION = 'coedit_ohne_gate' as const;
export type CoeditMethode = 'ohne_gate' | 'ready_gate';
export interface CoeditMethodeStand {
  wirksam: CoeditMethode;
  project: string | null;
  quelle: 'standard' | 'produkt-schalter' | 'intern';
  ebene: 'global' | 'projekt' | null;
  bis: string | null;
  letzter_fehler: string | null;
}

type Q = import('pg').QueryConfig & { query_timeout: number };

/** t215: letzter fehlerfrei gelesener Produkt-Schalter je Projekt, gilt bei Lesefehlern noch so lange weiter. */
const LETZTER_WERT_HALTEN_MS = 60_000;
const LETZTER_WERT = new Map<string, { bis: number; stand: ProfilProduktSchalterStand }>();

/** Wirksame Co-Edit-Methode fuer ein Projekt (intern-Override > Produkt-Schalter projekt > global > Standard AUS). */
export async function leseCoeditMethode(project: string | null): Promise<CoeditMethodeStand> {
  let p = await leseProfilProduktSchalterGepuffert(COEDIT_OHNE_GATE_FUNKTION, project);
  const schluessel = project ?? '';
  if (!p.letzter_fehler) LETZTER_WERT.set(schluessel, { bis: Date.now() + LETZTER_WERT_HALTEN_MS, stand: p });
  else {
    const alt = LETZTER_WERT.get(schluessel);
    if (alt && alt.bis > Date.now()) p = { ...alt.stand, letzter_fehler: p.letzter_fehler };
  }
  let stand: CoeditMethodeStand = {
    wirksam: p.aktiv ? 'ohne_gate' : 'ready_gate', project, quelle: p.quelle, ebene: p.ebene, bis: null, letzter_fehler: p.letzter_fehler,
  };
  if (internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean; bis: Date }>({
        text: "SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND bis > NOW()",
        values: [COEDIT_OHNE_GATE_FUNKTION], query_timeout: 2000,
      } as Q);
      const z = r.rows[0];
      if (z) stand = { ...stand, wirksam: z.aktiv ? 'ohne_gate' : 'ready_gate', quelle: 'intern', bis: new Date(z.bis).toISOString(), letzter_fehler: null };
    } catch { stand = { ...stand, letzter_fehler: COEDIT_OHNE_GATE_FUNKTION + '_override_nicht_lesbar' }; }
  }
  return stand;
}

/** Kurzform: true = neue Methode (ohne Gate) wirksam. */
export async function coeditOhneGate(project: string | null): Promise<boolean> {
  return (await leseCoeditMethode(project)).wirksam === 'ohne_gate';
}
