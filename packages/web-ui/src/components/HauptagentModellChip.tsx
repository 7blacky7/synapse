import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '../api/auth';
import { getMainAgentModelle, wechsleAgentModellUi, type MainAgentModelle, type MainAgentModellRuntime } from '../api/agent-runtime';
import { useCliModelle } from './CliModellAuswahl';
import { useLaufHerkunft } from './LaufHerkunftMarke';
import { findeLaufHerkunft } from './lauf-herkunft-logik';
import { oeffneAusweisVerwaltung } from '../ausweis-deeplink';
import {
  API_BASIS, API_GRUPPEN, AUTO_AUFTRAG, AUTO_GRUND, anbieterName, externerLauf, fehlerText, kurzGrund, modellwechselFehler, uebernahmeFrage, laufZeile, neuerStartSchluessel, preisEtikett, preisTitel, sperrCode, sperrGrund,
  type ApiAuswahlStand, type ApiLauf, type ApiModell,
} from './api-laufwahl-logik';
import '../hauptagent-modell-chip.css';

/**
 * P22-T62 (User 20.10. ~12:20): Modell-/Runtime-Wahl DIREKT im Kopf des Hauptagent-Chats als kompakter Chip
 * ('Claude Code · <modell>') mit Dropdown. Gruppen 'Claude Code' / 'Codex' aus GET /api/main-agent/modelle (nur bereite
 * Runtimes mit Liste, die andere mit ehrlichem Grund); ein Klick wechselt Runtime + Modell (POST /api/main-agent/wechsel).
 * Anzeige: gewaehlt (gewuenscht) vs. tatsaechlich laufend (GET /api/main-agent/status). Auch in der Steuerung genutzt.
 * P22-T281 (User 08.11.2026): EIN Chip fuer alle Identitaeten (identityId): Hauptagent, Koordinatorfenster, Agententeam/Ausweis-Fenster.
 *   - Andere Identitaeten: Gruppen aus den CLI-Katalogen (GET /api/agent-runtimes/:runtime/modelle), Wechsel ueber den vorhandenen
 *     Modellwechsel (wechsleAgentModellUi, P22-T117); aktuelle Laufart aus der Lauf-Herkunft (P22-T178), sonst 'extern · nicht identifizierbar'.
 *   - Schalter api_agenten_auswahl EIN: unter 'Claude Code' und 'Codex' die Gruppen 'API · Claude/OpenRouter/DeepSeek' in derselben
 *     Zeilenform mit Preis-Etikett; nicht startbare Eintraege ausgegraut mit kurzem Grund. Ein Klick oeffnet eine Bestaetigungszeile
 *     ('kostenpflichtig · bestätigen'); Vertraege unveraendert (laeufe/auswahl, starten, cli, steuern), Grund und Auftrag automatisch.
 *   - Debug nicht sichtbar: data-identitaet, data-laufart, data-api-schalter, data-api-blocker am Chip.
 */
interface StatusKurz {
  identitaet: null | { runtime_gewuenscht: string | null; runtime_tatsaechlich: string | null; modell_gewuenscht: string | null; modell_tatsaechlich: string | null };
  auftraege_offen: Array<{ art: string; status: string }>;
}

export const CLI_GRUPPE: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
const STANDARD_QUELLE: Record<string, string> = { user_wahl: 'deine Wahl', profil: 'gespeichertes Modell', kleinstes: 'kleinstes Modell', schalter_aus: 'Altstandard', keins: 'keins' };

async function anfrage<T>(pfad: string, body?: unknown): Promise<T> {
  const r = await apiFetch(pfad, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => null);
  if (!r.ok || (d as { success?: boolean } | null)?.success === false) {
    const e = (d as { error?: { code?: string; message?: string } | string } | null)?.error;
    throw new Error((typeof e === 'string' ? e : (e?.code ?? e?.message ?? 'fehler')) + ' (HTTP ' + r.status + ')');
  }
  return d as T;
}
const meldeText = (reason: unknown): string => fehlerText(reason instanceof Error ? reason.message : String(reason));

/** Kurzname fuer den Chip: Codex ohne Praefix 'codex/'. */
const kurz = (modell: string | null | undefined): string => (modell ? modell.replace(/^codex\//, '') : '–');

/** P22-T71: Zwischenschritte eines laufenden Wechsels (agent_runtime_auftraege.fortschritt). */
const SCHRITT: Record<string, string> = { stoppt_alt: 'stoppt', alt_gestoppt: 'gestoppt', startet: 'startet', laeuft: 'läuft' };
type Auftrag = { auftrag_id: string; art: string; status: string; offen?: boolean; letzter_fehler: string | null; gewuenscht?: Record<string, unknown>;
  erstellt_am: string; abgeschlossen_am: string | null; fortschritt?: { schritt?: string; runtime?: string } | null };

const KATALOG_LAEDT = 'Modelle werden gelesen …';
/** P22-T289: Laufstatus aus api_agent_laeufe fuer die Anzeige (laeuft -> läuft); sonst unveraendert (bereit, pausiert, gestoppt, fehler). */
const standText = (s: string): string => (s === 'laeuft' ? 'läuft' : s);
/** P22-T281: Gruppe aus dem CLI-Katalog fuer Identitaeten ausser dem Hauptagenten (gleiche Form wie GET /api/main-agent/modelle). */
function katalogGruppe(runtime: 'claude' | 'codex', k: ReturnType<typeof useCliModelle>): MainAgentModellRuntime {
  const l = k.liste;
  const standard = l?.modelle.find((m) => m.standard)?.id ?? null;
  return {
    runtime, label: CLI_GRUPPE[runtime], bereit: !!l && l.modelle.length > 0, zugewiesen: false,
    grund: k.fehler || (l ? l.grund : KATALOG_LAEDT),
    standard: { modell: standard, quelle: 'keins', grund: null, user_wahl: null }, user_wahl: null, pruefung: null,
    quelle: l?.quelle ?? null, quelle_detail: l?.quelle_detail ?? null, stand: l?.stand ?? null, cli_version: l?.cli_version ?? null, hinweise: l?.hinweise ?? [],
    modelle: (l?.modelle ?? []).map((m) => ({ ...m, modell: m.id })),
  };
}

/**
 * P22-T64: Mit status ersetzt der Chip die Statuspille im Chatkopf ('Claude · <modell> · bereit' mit Status-Punkt);
 * ohne status bleibt er der reine Modell-Chip (Steuerung). Andere Identitaeten zeigen immer die Pille.
 */
export interface ChipStatus { text: string; real: boolean; hinweis: string | null }

export function HauptagentModellChip({ kompakt = true, status: anzeige, identityId = 'main', project, name, ort }: {
  kompakt?: boolean; status?: ChipStatus;
  /** P22-T281: Identitaet des Agenten ('main' = Hauptagent). */
  identityId?: string; project?: string; name?: string;
  /** P22-T281: bekannter Ort des Laufs (herkunftText, z. B. 'CLI (Claude Code)'), Rueckfall ohne Lauf-Herkunft. */
  ort?: string | null;
}) {
  const istMain = identityId === 'main';
  const [modelle, setModelle] = useState<MainAgentModelle | null>(null);
  const [status, setStatus] = useState<StatusKurz | null>(null);
  const [api, setApi] = useState<ApiAuswahlStand | null>(null);
  const [lauf, setLauf] = useState<ApiLauf | null>(null);
  const [offen, setOffen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [apiZiel, setApiZiel] = useState<ApiModell | null>(null);
  const [busy, setBusy] = useState(false);
  const [meldung, setMeldung] = useState<{ text: string; fehler: boolean } | null>(null);
  // P22-T65 Bugfix: letzter abgelehnter/fehlgeschlagener Wechsel-Auftrag (Daemon lehnt z. B. eine Stufe ab) sichtbar am Chip.
  const [abgelehnt, setAbgelehnt] = useState<{ id: string; text: string } | null>(null);
  const quittiertRef = useRef<string | null>(null);
  // P22-T71: Fortschritt des laufenden Wechsels bis 'laeuft' (bzw. bis abgelehnt).
  const [fortschritt, setFortschritt] = useState<string | null>(null);
  const wurzel = useRef<HTMLDivElement>(null);
  const menueRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const startSchluessel = useRef(neuerStartSchluessel());
  // P22-T281: CLI-Kataloge und Lauf-Herkunft nur fuer andere Identitaeten (der Hauptagent hat GET /api/main-agent/modelle).
  const claudeKatalog = useCliModelle(istMain ? null : 'claude');
  const codexKatalog = useCliModelle(istMain ? null : 'codex');
  const herkunftDaten = useLaufHerkunft(istMain ? null : project);
  const herkunft = istMain ? null : findeLaufHerkunft(herkunftDaten, { identityId, name });

  const laden = useCallback(async () => {
    const g = ++generation.current;
    const [m, s, a, st] = await Promise.all([
      istMain ? getMainAgentModelle().catch(() => null) : Promise.resolve(null),
      istMain ? anfrage<StatusKurz>('/api/main-agent/status').catch(() => null) : Promise.resolve(null),
      istMain ? anfrage<{ auftraege?: Auftrag[] }>('/api/main-agent/auftraege').catch(() => null) : Promise.resolve(null),
      anfrage<ApiAuswahlStand>(API_BASIS + '/auswahl?identity_id=' + encodeURIComponent(identityId)).catch(() => null),
    ]);
    // P22-T289 Nachbesserung (User-Befund deepseek-umsetzer): ein API-Lauf (api_agent_laeufe) entsteht auch ohne Laufwahl, z. B. per
    // specialist spawn. Frueher wurde er nur mit Wahl gelesen -> Chip 'extern · nicht identifizierbar'. Quelle unveraendert GET api/laeufe?project.
    const laufProjekt = st?.identity?.project ?? (istMain ? null : project ?? null);
    const laufId = st?.identity?.identity_id ?? (istMain ? null : identityId);
    const l = laufProjekt && laufId
      ? (await anfrage<{ laeufe: ApiLauf[] }>(API_BASIS + '?project=' + encodeURIComponent(laufProjekt)).catch(() => null))?.laeufe
        .find((x) => x.identity_id === laufId) ?? null
      : null;
    if (g !== generation.current) return;
    setModelle(m);
    setStatus(s);
    setApi(st);
    setLauf(l);
    // Neuester Wechsel-Auftrag: schlug er fehl (abgelehnt/fehlgeschlagen), zeigt der Chip den Grund, bis ein neuer Wechsel kommt oder quittiert wird.
    const wechsel = (a?.auftraege ?? []).filter((x) => x.art === 'modellwechsel' || x.art === 'runtime_wechsel')
      .sort((x, y) => Date.parse(y.erstellt_am) - Date.parse(x.erstellt_am))[0];
    const f = wechsel?.offen ? wechsel.fortschritt ?? null : null;
    setFortschritt(wechsel?.offen
      ? 'Wechsel: ' + (f?.schritt ? (f.runtime ? (CLI_GRUPPE[f.runtime] ?? f.runtime) + ' ' : '') + (SCHRITT[f.schritt] ?? f.schritt) : wechsel.status === 'pending' ? 'wartet auf Ausführung' : 'beginnt') + ' …'
      : null);
    const fehlgeschlagen = !!wechsel && !wechsel.offen && !['completed', 'cancelled'].includes(wechsel.status)
      && Date.now() - Date.parse(wechsel.abgeschlossen_am ?? wechsel.erstellt_am) < 30 * 60_000;
    if (wechsel && fehlgeschlagen && quittiertRef.current !== wechsel.auftrag_id) {
      const gw = wechsel.gewuenscht ?? {};
      const was = [typeof gw.modell === 'string' ? kurz(gw.modell) : '', typeof gw.effort === 'string' ? gw.effort : ''].filter(Boolean).join(' · ');
      setAbgelehnt({ id: wechsel.auftrag_id, text: 'Wechsel' + (was ? ' zu ' + was : '') + ' ' + (wechsel.status === 'rejected' ? 'abgelehnt' : 'fehlgeschlagen') + ': ' + (wechsel.letzter_fehler ?? 'ohne Angabe') });
    } else {
      setAbgelehnt(null);
    }
  }, [identityId, istMain, project]);
  useEffect(() => {
    void laden();
    // Gewaehlt/laeuft aendert sich auch ohne Klick (Auftrag ausgefuehrt, Failover). Waehrend eines Wechsels alle 2 s (Fortschritt).
    const timer = window.setInterval(() => void laden(), fortschritt ? 2_000 : 15_000);
    const neu = () => void laden();
    window.addEventListener('synapse:laufwahl-geaendert', neu);
    return () => { window.clearInterval(timer); window.removeEventListener('synapse:laufwahl-geaendert', neu); };
  }, [laden, fortschritt !== null]);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => {
    if (!offen) return;
    void laden();
    const zu = (event: PointerEvent) => {
      const t = event.target as Node;
      if (!wurzel.current?.contains(t) && !menueRef.current?.contains(t)) { setOffen(false); setApiZiel(null); }
    };
    const taste = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOffen(false); setApiZiel(null); } };
    document.addEventListener('pointerdown', zu);
    document.addEventListener('keydown', taste);
    return () => { document.removeEventListener('pointerdown', zu); document.removeEventListener('keydown', taste); };
  }, [offen, laden]);

  const runtimes: MainAgentModellRuntime[] = istMain ? (modelle?.runtimes ?? []) : [katalogGruppe('claude', claudeKatalog), katalogGruppe('codex', codexKatalog)];
  const i = status?.identitaet ?? null;
  const zugewiesen = modelle?.runtimes.find((r) => r.zugewiesen)?.runtime ?? null;
  const ortRt = !istMain && ort ? (/codex/i.test(ort) ? 'codex' : /claude/i.test(ort) ? 'claude' : null) : null;
  const herkunftRt = herkunft?.art === 'cli' ? 'claude' : herkunft?.art === 'codex' ? 'codex' : herkunft?.art === 'api' ? null : ortRt;
  const rt = istMain ? i?.runtime_gewuenscht ?? zugewiesen : herkunftRt;
  const rtEintrag = runtimes.find((r) => r.runtime === rt) ?? null;
  const gewaehlt = istMain ? i?.modell_gewuenscht ?? rtEintrag?.standard.modell ?? null : herkunftRt ? herkunft?.modell ?? null : null;
  const laeuft = istMain ? i?.modell_tatsaechlich ?? null : gewaehlt;
  const laufRt = istMain ? i?.runtime_tatsaechlich ?? null : herkunftRt;
  // P22-T65: Effort des gewaehlten Modells = gespeicherte Stufe, sonst standard_effort aus dem Katalog.
  const effortVon = (m: { effort_wahl?: string | null; standard_effort: string | null }): string | null => m.effort_wahl ?? m.standard_effort ?? null;
  const gleich = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && (a === b || kurz(a) === kurz(b));
  const gewaehltEintrag = rtEintrag?.modelle.find((m) => gleich(m.modell, gewaehlt)) ?? null;
  const aktuellerEffort = istMain && gewaehltEintrag ? effortVon(gewaehltEintrag) : null;
  const wechselOffen = (status?.auftraege_offen ?? []).some((a) => a.art === 'runtime_wechsel' || a.art === 'modellwechsel');
  // P22-T281: aktuelle Laufart; ein API-Lauf bzw. eine API-Wahl geht vor der CLI-Anzeige.
  // P22-T289: ein API-Lauf ohne Wahl zaehlt, solange er bereit/laeuft/pausiert ist; gestoppt bzw. mit Fehler nur, wenn kein CLI-Lauf erkennbar ist.
  const laufZaehlt = !!lauf && (!!api?.wahl || !['gestoppt', 'fehler'].includes(lauf.status) || !rt);
  const apiAktuell = lauf && laufZaehlt ? { modell: lauf.modell, anbieter: lauf.anbieter, stand: standText(lauf.status) } : api?.wahl ? { modell: api.wahl.modell, anbieter: api.wahl.anbieter, stand: api.wahl.phase } : null;
  const apiText = apiAktuell ? 'API · ' + anbieterName(apiAktuell.anbieter) + ' · ' + apiAktuell.modell : '';
  const laufart = apiAktuell ? 'api' : rt ? rt === 'claude' ? 'cli' : 'codex' : 'extern';
  const cliText = rt ? (CLI_GRUPPE[rt] ?? rt) + ' · ' + (gewaehlt || istMain ? kurz(gewaehlt) : 'Modell unbekannt') + (aktuellerEffort ? ' · ' + aktuellerEffort : '') : '';
  const pillText = istMain
    ? apiAktuell ? anzeige?.text ?? apiText : (rt ? (rt === 'claude' ? 'Claude' : CLI_GRUPPE[rt] ?? rt) + ' · ' + kurz(gewaehlt) + (aktuellerEffort ? ' · ' + aktuellerEffort : '') + ' · ' : '') + (anzeige?.text ?? '')
    : apiAktuell ? apiText + ' · ' + apiAktuell.stand : cliText || 'extern · nicht identifizierbar';
  const pille = !!anzeige || !istMain;
  const real = istMain ? !!anzeige?.real : laufart !== 'extern';
  const titel = istMain
    ? 'Gewählt: ' + (apiAktuell ? apiText : rt ? (CLI_GRUPPE[rt] ?? rt) + ' · ' + (gewaehlt ?? 'Standard') : 'keine Runtime')
      + ' · läuft: ' + (i?.runtime_tatsaechlich ? (CLI_GRUPPE[i.runtime_tatsaechlich] ?? i.runtime_tatsaechlich) + ' · ' + (laeuft ?? '?') : 'unbestätigt')
      + (wechselOffen ? ' · Wechsel läuft' : '')
    : (apiAktuell ? apiText + ' · ' + apiAktuell.stand : cliText ? 'Läuft über ' + cliText : 'Kein CLI- oder API-Lauf dieser Identität erkennbar (z. B. Web-KI).')
      + (ort ? ' · Ort: ' + ort : '') + (name ? ' · ' + name : '');

  const fertig = (text: string) => {
    setMeldung({ text, fehler: false });
    setAbgelehnt(null);
    setApiZiel(null);
    setOffen(false);
    window.dispatchEvent(new Event('synapse:laufwahl-geaendert'));
  };
  // CLI-Wechsel; laeuft die Identitaet gerade per API, beendet der vorhandene Weg (POST laeufe/cli) die API zuerst.
  const waehle = async (runtime: string, modell: string, effort?: string) => {
    setBusy(true);
    try {
      if (apiAktuell) await anfrage(API_BASIS + '/cli', { identity_id: identityId, grund: AUTO_GRUND });
      if (istMain) await anfrage('/api/main-agent/wechsel', { runtime, modell, ...(effort ? { effort } : {}), grund: 'Modellwahl im Hauptagent-Chat' });
      else {
        // P22-T326 F4: externer Lauf -> Rueckfrage, danach mit uebernahme_bestaetigt; fachlicher Fehler (auch Rueckfall) als Meldung.
        let r = await wechsleAgentModellUi(identityId, runtime as 'claude' | 'codex', modell, AUTO_GRUND);
        const ext = externerLauf(r);
        if (ext) {
          if (!window.confirm(uebernahmeFrage(ext))) { setMeldung({ text: 'Wechsel abgebrochen, der Lauf auf ' + ext.herkunftsort + ' bleibt.', fehler: false }); return; }
          r = await wechsleAgentModellUi(identityId, runtime as 'claude' | 'codex', modell, AUTO_GRUND, true);
        }
        const f = modellwechselFehler(r);
        if (f) throw new Error(f);
      }
      fertig('Wechsel zu ' + (CLI_GRUPPE[runtime] ?? runtime) + ' · ' + kurz(modell) + (effort ? ' · ' + effort : '') + ' beauftragt.');
      await laden();
    } catch (reason) {
      setMeldung({ text: meldeText(reason), fehler: true });
    } finally {
      setBusy(false);
    }
  };
  // API-Wechsel nach der Bestaetigungszeile: derselbe Startvertrag wie bisher, Grund und Auftrag automatisch.
  const starteApi = async (m: ApiModell) => {
    setBusy(true);
    try {
      await anfrage(API_BASIS + '/starten', { identity_id: identityId, modell: m.alias, auftrag: AUTO_AUFTRAG, grund: AUTO_GRUND,
        kosten_bestaetigt: true, wechsel_bestaetigt: true, idempotenz_schluessel: startSchluessel.current });
      startSchluessel.current = neuerStartSchluessel();
      fertig('Wechsel zu API · ' + anbieterName(m.anbieter) + ' · ' + m.alias + ' beauftragt.');
      await laden();
    } catch (reason) {
      setMeldung({ text: meldeText(reason), fehler: true });
      setOffen(false);
    } finally {
      setBusy(false);
    }
  };
  const steuern = async (aktion: 'stoppen' | 'fortsetzen') => {
    if (!lauf) return;
    setBusy(true);
    try {
      await anfrage(API_BASIS + '/steuern', { identity_id: lauf.identity_id, aktion, grund: 'API-Lauf im Modell-Chip ' + (aktion === 'stoppen' ? 'gestoppt' : 'fortgesetzt') });
      fertig('API-Lauf ' + (aktion === 'stoppen' ? 'gestoppt.' : 'fortgesetzt.'));
      await laden();
    } catch (reason) {
      setMeldung({ text: meldeText(reason), fehler: true });
      setOffen(false);
    } finally {
      setBusy(false);
    }
  };
  const umschalten = () => {
    if (busy) return;
    if (offen) { setOffen(false); setApiZiel(null); return; }
    const r = wurzel.current?.getBoundingClientRect();
    const breite = Math.min(340, window.innerWidth * 0.8);
    if (r) setPos({ x: Math.min(window.innerWidth - 8, Math.max(r.right, breite + 8)), y: r.bottom });
    setMeldung(null);
    setOffen(true);
  };

  type Gruppe = MainAgentModellRuntime;
  type ModellEintrag = Gruppe['modelle'][number];

  // P22-T65 Nachtrag: Modellwechsel. Gilt die bisherige Stufe beim neuen Modell nicht, wird dessen Standard gesetzt (mit Hinweis).
  const waehleModell = async (r: Gruppe, m: ModellEintrag) => {
    const bisher = r.runtime === rt ? aktuellerEffort : null;
    const ungueltig = istMain && !!bisher && m.effort_stufen.length > 0 && !m.effort_stufen.includes(bisher);
    await waehle(r.runtime, m.modell, ungueltig ? (m.standard_effort ?? undefined) : undefined);
    if (ungueltig) setMeldung({ text: 'Effort ' + bisher + ' gibt es bei ' + m.name + ' nicht, Standard ' + (m.standard_effort ?? '–') + ' gesetzt.', fehler: false });
  };

  // P22-T65 Nachtrag: EINE Effort-Leiste je Gruppe, direkt unter der Kopfzeile, fuer das gewaehlte bzw. (andere Gruppe) vorgemerkte
  // Modell, mit genau den Stufen dieses Modells laut CLI-Liste. Hinweise der CLI nur zur gewaehlten Stufe, sonst im Tooltip.
  const EffortLeiste = ({ r }: { r: Gruppe }) => {
    const modellId = r.runtime === rt ? gewaehlt : (r.user_wahl ?? r.standard.modell);
    const m = r.modelle.find((x) => x.modell === modellId);
    if (!m || m.effort_stufen.length === 0) return null;
    const aktivGruppe = r.runtime === rt;
    const jetzt = effortVon(m);
    const details = new Map((m.effort_details ?? []).map((d) => [d.stufe, d]));
    const hinweis = jetzt ? details.get(jetzt)?.hinweis : null;
    return <div className="effort-leiste">
      <div className="efforts" role="group" aria-label={'Effort ' + m.name}>
        <small>Effort · {m.name}</small>
        {m.effort_stufen.map((s) => {
          const d = details.get(s);
          const an = s === jetzt;
          return <button key={s} type="button" className={'effort' + (an ? ' an' : '') + (s === m.standard_effort ? ' std' : '')}
            disabled={busy || (aktivGruppe && an)} title={[d?.name, s === m.standard_effort ? 'Standard der CLI' : '', d?.hinweis].filter(Boolean).join(' – ')}
            onClick={() => void waehle(r.runtime, m.modell, s)}>{s}{d?.hinweis && /recommended/i.test(d.hinweis) ? ' ★' : ''}</button>;
        })}
      </div>
      {hinweis && <small className="effort-hinweise">{jetzt}: {hinweis}</small>}
    </div>;
  };

  const apiAn = api?.schalter.aktiv === true;
  const apiGesperrt = apiAn && (api?.modelle ?? []).some((m) => !!sperrGrund(api!, m));
  const menue = offen && pos && createPortal(
    <div ref={menueRef} className="hauptagent-modell-chip chip-portal" style={{ left: pos.x, top: pos.y }} onPointerDown={(event) => event.stopPropagation()}>
      <div className="chip-menue" role="menu" aria-label={'Modell ' + (name ?? 'Hauptagent')} style={{ maxHeight: 'min(64vh, calc(100vh - ' + Math.round(pos.y + 16) + 'px))' }}>
        {istMain && !modelle && <p>Modelllisten nicht ladbar.</p>}
        {istMain && modelle && !modelle.schalter.aktiv && <p className="hinweis">Modellwahl aus den CLI-Listen ist AUS (Schalter hauptagent_cli_modelle): Altverhalten, keine Listenprüfung.</p>}
        {lauf && <div className="gruppe">
          <strong>API-Lauf · {anbieterName(lauf.anbieter)} · {lauf.modell}</strong>
          <small>{laufZeile(lauf)}</small>
          {lauf.letzter_fehler && <small className="hinweis" title={lauf.letzter_fehler}>{fehlerText(lauf.letzter_fehler)}</small>}
          <div className="effort-leiste"><div className="efforts">
            <button type="button" className="effort" disabled={busy} onClick={() => void steuern('stoppen')}>stoppen</button>
            <button type="button" className="effort" disabled={busy} onClick={() => void steuern('fortsetzen')}>fortsetzen</button>
          </div></div>
        </div>}
        {runtimes.map((r) => <div key={r.runtime} className="gruppe">
          <strong>{CLI_GRUPPE[r.runtime] ?? r.label}</strong>
          <small>{!r.bereit
            ? r.grund === KATALOG_LAEDT ? KATALOG_LAEDT : 'nicht verfügbar: ' + (r.grund ?? 'unbekannt')
            : istMain ? 'Standard ' + kurz(r.standard.modell) + ' (' + (STANDARD_QUELLE[r.standard.quelle] ?? r.standard.quelle) + ')'
              : (r.standard.modell ? 'Standard der CLI ' + kurz(r.standard.modell) : '') + (r.cli_version ? (r.standard.modell ? ' · ' : '') + r.cli_version : '')}</small>
          {istMain && r.pruefung && (r.pruefung.hinweis || !kompakt) && <small className={r.pruefung.haengt ? 'hinweis' : ''} title={r.pruefung.letzter_lauf.meldung ?? ''}>
            {'Prüfung: ' + r.pruefung.letzter_lauf.ergebnis + ', ' + r.pruefung.letzter_lauf.dauer_ms + ' ms'
              + (r.pruefung.alter_sekunden !== null ? ', bestätigt vor ' + r.pruefung.alter_sekunden + ' s' : '')
              + (r.pruefung.hinweis ? ' – ' + r.pruefung.hinweis : '') + (r.pruefung.schalter.aktiv ? '' : ' (Stabilisierung AUS)')}</small>}
          {istMain && r.bereit && r.modelle.length === 0 && <small className="hinweis">keine Modelle: {r.grund ?? 'unbekannt'}</small>}
          {istMain && r.bereit && modelle?.schalter.aktiv && !apiAktuell && <EffortLeiste r={r} />}
          {r.bereit && r.modelle.filter((m) => m.sichtbar || m.modell === r.user_wahl || gleich(m.modell, gewaehlt)).map((m) => {
            const aktiv = !apiAktuell && r.runtime === rt && gleich(m.modell, gewaehlt);
            return <div key={m.modell} className={'modell-zeile' + (aktiv ? ' aktiv' : '')}>
              <button type="button" role="menuitem" className={aktiv ? 'aktiv' : ''} disabled={busy || aktiv} title={m.beschreibung ?? ''}
                onClick={() => void waehleModell(r, m)}>
                <span>{m.name}</span><code>{m.id}</code>
                <em>{[m.modell === r.standard.modell ? 'Standard' : '', istMain && m.modell === r.user_wahl ? 'deine Wahl' : '',
                  !apiAktuell && r.runtime === laufRt && gleich(m.modell, laeuft) ? 'läuft' : ''].filter(Boolean).join(' · ')}</em>
              </button>
            </div>;
          })}
        </div>)}
        {apiAn && api && API_GRUPPEN.map((g) => {
          const liste = api.modelle.filter((m) => m.anbieter === g.anbieter);
          if (!liste.length) return null;
          return <div key={g.anbieter} className="gruppe api">
            <strong>{g.titel}</strong>
            {liste.map((m) => {
              const code = sperrCode(api, m);
              const grund = code ? kurzGrund(code) : null;
              const aktiv = !!apiAktuell && apiAktuell.modell === m.alias && apiAktuell.anbieter === m.anbieter;
              const gewaehltHier = apiZiel?.alias === m.alias;
              return <div key={m.alias} className={'modell-zeile' + (aktiv ? ' aktiv' : '')}>
                <button type="button" role="menuitem" className={aktiv ? 'aktiv' : ''} disabled={busy || aktiv || !!grund}
                  title={preisTitel(m) + (code ? ' · nicht startbar: ' + fehlerText(code) : '')} onClick={() => setApiZiel(gewaehltHier ? null : m)}>
                  <span>{m.alias}</span><code>{preisEtikett(m)}</code>
                  <em>{[aktiv ? 'läuft' : '', grund ?? ''].filter(Boolean).join(' · ')}</em>
                </button>
                {gewaehltHier && <div className="effort-leiste"><div className="efforts" role="group" aria-label={'API-Wechsel zu ' + m.alias + ' bestätigen'}>
                  <small>Startet sofort einen kostenpflichtigen API-Lauf · {preisEtikett(m)} je 1 Mio Tokens (Ein / Aus){rt || apiAktuell ? ' · der bisherige Lauf wird kontrolliert gestoppt' : ''}</small>
                  <button type="button" className="effort an" disabled={busy} onClick={() => void starteApi(m)}>{busy ? 'startet …' : 'kostenpflichtig starten'}</button>
                  <button type="button" className="effort" disabled={busy} onClick={() => setApiZiel(null)}>abbrechen</button>
                </div></div>}
              </div>;
            })}
          </div>;
        })}
        {apiGesperrt && <small className="hinweis">Ausgegraut: Budget, Freigabe oder Schalter fehlen. <button type="button" className="chip-link"
          onClick={() => { setOffen(false); oeffneAusweisVerwaltung({ project: project ?? api?.identity?.project ?? 'synapse', agentId: '', bereich: 'api' }); }}>Einstellungen › API-Agenten</button></small>}
        {istMain && !kompakt && modelle && <small>Schalter {modelle.schalter.aktiv ? 'EIN' : 'AUS'} ({modelle.schalter.quelle})</small>}
      </div>
    </div>, document.querySelector('.synapse-control') ?? document.body);

  return <div className={'hauptagent-modell-chip' + (kompakt ? ' kompakt' : '')} ref={wurzel} onPointerDown={(event) => event.stopPropagation()}
    data-identitaet={identityId} data-laufart={laufart} data-api-schalter={api ? (apiAn ? 'ein' : 'aus') : 'unbekannt'}
    data-api-blocker={(api?.blocker ?? []).join(',') || undefined}>
    {pille
      ? <div role="button" tabIndex={0} aria-haspopup="menu" aria-expanded={offen}
        className={'agent-live chip-status' + (real ? ' real' : '') + (offen ? ' offen' : '') + (wechselOffen ? ' wechselt' : '')}
        title={titel + (anzeige?.hinweis ? ' · ' + anzeige.hinweis : '')}
        onClick={umschalten}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); umschalten(); } }}>
        <i /><span className="chip-text">{pillText}{anzeige?.hinweis ? ' ⚠' : ''}{wechselOffen ? ' …' : ''}</span><span className="chip-pfeil" aria-hidden="true">▾</span>
      </div>
      : <button type="button" className={'chip' + (offen ? ' offen' : '') + (wechselOffen ? ' wechselt' : '')} title={titel} disabled={busy} onClick={umschalten}>
        {apiAktuell ? apiText : <>{rt ? (CLI_GRUPPE[rt] ?? rt) : 'Modell'} · {kurz(gewaehlt)}{aktuellerEffort ? ' · ' + aktuellerEffort : ''}{laeuft && laeuft !== gewaehlt ? ' (läuft ' + kurz(laeuft) + ')' : ''}</>}{wechselOffen ? ' …' : ''} ▾
      </button>}
    {abgelehnt && !meldung && <small className="chip-meldung fehler" title={abgelehnt.text}
      onClick={() => { quittiertRef.current = abgelehnt.id; setAbgelehnt(null); }}>⚠ {abgelehnt.text} (Klick blendet aus)</small>}
    {fortschritt && !offen && <small className="chip-meldung" title={fortschritt}>{fortschritt}</small>}
    {meldung && !offen && !fortschritt && <small className={'chip-meldung' + (meldung.fehler ? ' fehler' : '')} title={meldung.text}>{meldung.fehler ? '⚠ ' : '✓ '}{meldung.text}</small>}
    {menue}
  </div>;
}
