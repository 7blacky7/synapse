/**
 * MODUL: Jev-Steuerung am admin-Tool (P15-T33 E0.5, 11.10.2026). EIN Dispatcher fuer REST und stdio.
 *
 * ACTIONS:
 *   jev_status   (project?)  wirksamer Stand je Funktion fuer das Projekt, gesetzte Schalter, Budget,
 *                            Kosten des laufenden Monats, Sichtbarkeit des Tools jev in tools/list.
 *   jev_schalten (ebene global|projekt, project bei projekt, funktion alle|empfehlung|entscheidung|
 *                plan_einordnen|erklaerungstopf|tool, aktiv, grund) - nur Koordinator/User.
 *   jev_kosten   (seit?, bis?, nur_dieses_projekt?) Summen je Tag, Monat, Projekt, Funktion.
 *   jev_budget   (modus status|setzen|entfernen|zuruecksetzen, grenze_usd, reset_tag, kontostand)
 *                setzen/entfernen/zuruecksetzen nur Koordinator/User; kontostand:true fragt
 *                GET /api/v1/key (limit, limit_remaining ...).
 * BERECHTIGUNG: Namenstreue wie jev(abwesend): agent_id koordinator|coordinator|user. Keine
 *   Identitaetspruefung.
 */

import { JEV_FUNKTIONEN, JevSchalterFehler, jevSchalterListe, jevWirksam, setzeJevSchalter, filtereJevTool } from './jev-schalter.js';
import { holeJevKontostand, jevBudgetStand, jevKostenUebersicht, setzeJevBudget, setzeJevBudgetZurueck } from './jev-kosten.js';
import { JEV_SPRACHEN, JevOptionenFehler, leseJevOptionen, setzeJevOptionen } from './jev-optionen.js';
import { entscheidungstopfStatus, ergaenzeTopfEmbeddings, ladeEntscheidungstopfSeed } from './entscheidungstopf.js';
import { erklaerungstopfStatus, holeErklaerungsEreignisseNach, ladeErklaerungstopfSeed } from './erklaerungen.js';

export const JEV_ADMIN_ACTIONS = ['jev_status', 'jev_schalten', 'jev_kosten', 'jev_budget', 'jev_optionen', 'jev_entscheidungstopf', 'jev_erklaerungstopf'] as const;
import { darfKoordinatorOderUser } from './rollen-pruefung.js';

/** Beschreibungssatz fuer die admin-Tool-Definition (REST und stdio). */
export const JEV_ADMIN_BESCHREIBUNG =
  ' Jev-Steuerung: jev_status (wirksamer Stand je Funktion, Schalter, Budget, Monatskosten), ' +
  'jev_schalten (ebene global|projekt, funktion alle|empfehlung|entscheidung|plan_einordnen|erklaerungstopf|entscheidungstopf|tool, aktiv, grund; nur Koordinator/User; ' +
  'global aus = ueberall aus, Jev wird nicht aufgerufen und alle Jev-Hinweise verschwinden), ' +
  'jev_kosten (Summen je Tag/Monat/Projekt/Funktion in USD), jev_budget (modus status|setzen|entfernen|zuruecksetzen, grenze_usd je Monat, reset_tag, kontostand:true = OpenRouter-Kontostand), ' +
  'jev_optionen (modus status|setzen; erklaerung_de/erklaerung_en = gepflegte Erklaerungssprachen, mind. eine an; jev_sprache en|de|mix, nur aus gepflegten Sprachen, sonst Rueckfall mit Hinweis; entscheidung_ohne_praezedenz true|false = Jev waehlt auch ohne Praezedenz aus dem Entscheidungs-Topf, Standard true), ' +
  'jev_entscheidungstopf (modus status = Zaehlung je Status/Herkunft | seed_laden = Startbestand idempotent laden, nur Koordinator/User), ' +
  'jev_erklaerungstopf (modus status = Erklaerungen je Familie/Status, offene Faelle, Warteschlange | seed_laden = Startbestand idempotent laden | nachholen = liegengebliebene Fehlersituationen verarbeiten; seed_laden/nachholen nur Koordinator/User).';

/** Zusaetzliche Parameter am admin-Tool (Schema-Properties, REST und stdio identisch). */
export const JEV_ADMIN_PARAMETER: Record<string, Record<string, unknown>> = {
  ebene: { type: 'string', enum: ['global', 'projekt'], description: 'jev_schalten: global (alle Projekte) oder projekt (dann project)' },
  funktion: { type: 'string', enum: ['alle', ...JEV_FUNKTIONEN], description: 'jev_schalten: welche Jev-Funktion (Standard alle)' },
  aktiv: { type: 'boolean', description: 'jev_schalten: true = an, false = aus (Pflicht)' },
  grund: { type: 'string', description: 'jev_schalten: Grund (sichtbar in jev_status)' },
  modus: { type: 'string', enum: ['status', 'setzen', 'entfernen', 'zuruecksetzen', 'seed_laden', 'nachholen'], description: 'jev_budget: status (Standard) | setzen (grenze_usd) | entfernen (keine Bremse) | zuruecksetzen (Monatszaehler 0); jev_entscheidungstopf: status | seed_laden; jev_erklaerungstopf: status | seed_laden | nachholen' },
  grenze_usd: { type: 'number', description: 'jev_budget setzen: globale Kostengrenze in USD je Abrechnungsmonat' },
  reset_tag: { type: 'number', description: 'jev_budget setzen: Tag im Monat (1..28), an dem der Zaehler neu beginnt (Standard 1)' },
  kontostand: { type: 'boolean', description: 'jev_budget: true = OpenRouter-Kontostand (GET /api/v1/key) mitliefern' },
  seit: { type: 'string', description: 'jev_kosten: ISO-Zeitpunkt (Standard vor 365 Tagen)' },
  bis: { type: 'string', description: 'jev_kosten: ISO-Zeitpunkt (Standard jetzt)' },
  nur_dieses_projekt: { type: 'boolean', description: 'jev_kosten: nur Aufrufe von project' },
  erklaerung_de: { type: 'boolean', description: 'jev_optionen setzen: Deutsch als gepflegte Erklaerungssprache an/aus (mind. eine an)' },
  erklaerung_en: { type: 'boolean', description: 'jev_optionen setzen: Englisch als gepflegte Erklaerungssprache an/aus (mind. eine an)' },
  entscheidung_ohne_praezedenz: { type: 'boolean', description: 'jev_optionen setzen: true = Jev waehlt auch ohne passende Praezedenz aus dem Entscheidungs-Topf (markiert, Durchsicht zuerst), false = offene Frage fuer den User (Standard true)' },
  jev_sprache: { type: 'string', enum: [...JEV_SPRACHEN], description: 'jev_optionen setzen: Sprache, die Jev angeboten bekommt (en Standard | de | mix); nur aus den gepflegten Sprachen, sonst Rueckfall mit Hinweis' },
};

export function istJevAdminAction(action: string | undefined): boolean {
  return typeof action === 'string' && (JEV_ADMIN_ACTIONS as readonly string[]).includes(action);
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
function zahl(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
function wahr(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

const nurKoordinator = (wer: string) => ({
  success: false,
  error: 'nur_koordinator',
  message: `Jev-Schalter und -Budget setzen nur User oder Koordinator (agent_id koordinator|coordinator|user), bekommen: "${wer}". Namenstreue, keine Identitaetspruefung.`,
});

async function wirksamJeFunktion(project: string | null): Promise<Record<string, unknown>> {
  const aus: Record<string, unknown> = {};
  for (const f of JEV_FUNKTIONEN) aus[f] = await jevWirksam(project, f);
  return aus;
}

/** Fuehrt eine jev_*-Action aus. Wirft nie (Fehler als success:false). */
export async function fuehreJevAdminAus(
  action: string,
  args: Record<string, unknown>,
  agentId?: string | null,
  deps: { fetch?: typeof fetch } = {},
): Promise<Record<string, unknown>> {
  const wer = text(agentId) ?? text(args.agent_id) ?? '';
  const project = text(args.project) ?? null;
  try {
    switch (action) {
      case 'jev_status': {
        const budget = await jevBudgetStand().catch((e: Error) => ({ fehler: e.message }));
        const kosten = await jevKostenUebersicht({ seit: new Date(Date.now() - 31 * 86_400_000).toISOString() }).catch((e: Error) => ({ fehler: e.message }));
        const sichtbar = (await filtereJevTool([{ name: 'jev' }])).length === 1;
        return {
          success: true,
          project,
          wirksam: await wirksamJeFunktion(project),
          schalter: await jevSchalterListe(project),
          budget,
          kosten_31_tage: 'gesamt' in kosten ? { gesamt: kosten.gesamt, je_funktion: kosten.je_funktion } : kosten,
          jev_tool_in_tools_list: sichtbar,
          optionen: await leseJevOptionen(),
          hinweis: 'Vorrang: global aus = ueberall aus; sonst Projekt, dann Funktion; Budget-Pause wirkt wie global aus. Ohne Zeile = an.',
        };
      }
      case 'jev_schalten': {
        if (!darfKoordinatorOderUser(wer)) return nurKoordinator(wer);
        const aktiv = wahr(args.aktiv);
        if (aktiv === undefined) return { success: false, error: 'aktiv_fehlt', message: 'aktiv (true = an, false = aus) ist Pflicht.' };
        const ebene = text(args.ebene) ?? '';
        const zeile = await setzeJevSchalter({
          ebene,
          project,
          funktion: text(args.funktion) ?? 'alle',
          aktiv,
          grund: text(args.grund) ?? null,
          agent: wer,
        });
        return {
          success: true,
          schalter: zeile,
          wirksam: await wirksamJeFunktion(ebene === 'projekt' ? project : null),
          message: `Jev ${zeile.funktion === 'alle' ? '' : `(${zeile.funktion}) `}${zeile.ebene === 'global' ? 'global' : `fuer ${zeile.project}`} ${aktiv ? 'eingeschaltet' : 'abgeschaltet'}. ` +
            'Andere Prozesse (lokale MCP-Server) uebernehmen den Stand nach spaetestens JEV_SCHALTER_CACHE_MS (Standard 5 s); MCP-Clients sehen eine geaenderte Tool-Liste erst nach neuem tools/list.',
        };
      }
      case 'jev_kosten': {
        const nurProjekt = wahr(args.nur_dieses_projekt) === true;
        if (nurProjekt && !project) return { success: false, error: 'project_fehlt', message: 'nur_dieses_projekt braucht project.' };
        const kosten = await jevKostenUebersicht({ seit: text(args.seit), bis: text(args.bis), project: nurProjekt ? project : null });
        return { success: true, kosten };
      }
      case 'jev_budget': {
        const modus = text(args.modus) ?? 'status';
        if (modus !== 'status' && !darfKoordinatorOderUser(wer)) return nurKoordinator(wer);
        let budget;
        if (modus === 'setzen') {
          const grenze = zahl(args.grenze_usd);
          if (grenze === undefined) return { success: false, error: 'grenze_fehlt', message: 'modus setzen braucht grenze_usd (USD je Abrechnungsmonat, > 0).' };
          budget = await setzeJevBudget({ grenze_usd: grenze, reset_tag: zahl(args.reset_tag), agent: wer });
        } else if (modus === 'entfernen') {
          budget = await setzeJevBudget({ grenze_usd: null, reset_tag: zahl(args.reset_tag), agent: wer });
        } else if (modus === 'zuruecksetzen') {
          budget = await setzeJevBudgetZurueck({ agent: wer });
        } else if (modus === 'status') {
          budget = await jevBudgetStand();
        } else {
          return { success: false, error: 'modus_ungueltig', message: 'modus: status | setzen | entfernen | zuruecksetzen.' };
        }
        return {
          success: true,
          budget,
          ...(wahr(args.kontostand) === true ? { kontostand: await holeJevKontostand(deps) } : {}),
          hinweis: budget.grenze_usd === null ? 'Keine Grenze gesetzt: keine Bremse.' : 'Bei Erreichen pausiert Jev automatisch bis zum Reset (reset_tag) oder bis zur Aenderung per jev_budget.',
        };
      }
      case 'jev_optionen': {
        const modus = text(args.modus) ?? 'status';
        if (modus === 'status') return { success: true, optionen: await leseJevOptionen() };
        if (modus !== 'setzen') return { success: false, error: 'modus_ungueltig', message: 'jev_optionen: modus status | setzen.' };
        if (!darfKoordinatorOderUser(wer)) return nurKoordinator(wer);
        const optionen = await setzeJevOptionen({
          erklaerung_de: wahr(args.erklaerung_de),
          erklaerung_en: wahr(args.erklaerung_en),
          jev_sprache: text(args.jev_sprache),
          entscheidung_ohne_praezedenz: wahr(args.entscheidung_ohne_praezedenz),
          agent: wer,
        });
        return { success: true, optionen, message: 'Jev-Optionen gespeichert (wirken ab E1, Erklaerungstopf).' };
      }
      case 'jev_entscheidungstopf': {
        const modus = text(args.modus) ?? 'status';
        if (modus === 'status') return { success: true, topf: await entscheidungstopfStatus() };
        if (modus !== 'seed_laden') return { success: false, error: 'modus_ungueltig', message: 'jev_entscheidungstopf: modus status | seed_laden.' };
        if (!darfKoordinatorOderUser(wer)) return nurKoordinator(wer);
        const seed = await ladeEntscheidungstopfSeed({ agent: wer });
        void ergaenzeTopfEmbeddings();
        return { ...seed, topf: await entscheidungstopfStatus(), hinweis: 'Idempotent (Inhalts-ID und bestehende Seed-Inhalte). Vektoren werden im Hintergrund berechnet. Durchsicht durch den User: jev(action:"topf", herkunft:"seed").' };
      }
      case 'jev_erklaerungstopf': {
        // P15-T33 E2: Erklaerungs-Topf - Stand, Startbestand, Nachholen liegengebliebener Fehlersituationen
        const modus = text(args.modus) ?? 'status';
        if (modus === 'status') return { success: true, topf: await erklaerungstopfStatus() };
        if (modus !== 'seed_laden' && modus !== 'nachholen') {
          return { success: false, error: 'modus_ungueltig', message: 'jev_erklaerungstopf: modus status | seed_laden | nachholen.' };
        }
        if (!darfKoordinatorOderUser(wer)) return nurKoordinator(wer);
        if (modus === 'nachholen') {
          const n = await holeErklaerungsEreignisseNach();
          return { success: !n.error, ...n, topf: await erklaerungstopfStatus() };
        }
        const seed = await ladeErklaerungstopfSeed({ agent: wer });
        return { ...seed, topf: await erklaerungstopfStatus(), hinweis: 'Idempotent (Inhalts-ID; gleiche Lage in der Familie gilt als vorhanden). Liste: code_check(action:"erklaerungen").' };
      }
      default:
        return { success: false, error: 'unbekannte_action', message: `Unbekannte Jev-Action "${action}". Erlaubt: ${JEV_ADMIN_ACTIONS.join(', ')}.` };
    }
  } catch (err) {
    if (err instanceof JevSchalterFehler || err instanceof JevOptionenFehler) return { success: false, error: err.code, message: err.message };
    return { success: false, error: 'fehler', message: err instanceof Error ? err.message : String(err) };
  }
}
