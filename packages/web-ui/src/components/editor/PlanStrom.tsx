import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { apiFetch } from '../../api/auth';
import '../../editor-plan-strom-p22-t263.css';
import {
  PlanStromGedaechtnis, ZUSTAND_TEXT, OP_ZEICHEN, OFFEN_STANDARD_SEKUNDEN, fristBeginn, geaenderteZeilen, dateiname,
  dateiSignatur, schattenFaellig,
  type StromPlan, type StromEintrag, type StromPhase,
} from './plan-strom-logik';
// P22-T266: Syntax-Hervorhebung der Schatten und committeten Inhalte (Schalter editor_syntax ueber SyntaxAn).
import { HervorgehobenerText, useZeilenTokens, ZeilenInhalt } from './hervorhebung';

/*
 * P22-T263 (User-Vorgabe thought 9a3005ff, Gestaltung claude-linde): Editor-Live-Plan als EIN durchgehender Strom aus PG.
 * - Liste im Inspektor: jeder files-Plan des Projekts entsteht live (Ops laufen einzeln ein), beendete Pläne spielen ihre
 *   Abschlussanimation ganz ab und bleiben editor_plan_offen_sekunden (Standard 20 s) offen; die Fristleiste zeigt die Restzeit.
 * - Klick auf einen Plan: unteres Panel mit ALLEN aktuellen Schatten des Plans; ist er committet (oder wird er committet, während
 *   das Panel offen ist), zusätzlich die committeten Inhalte aus PG mit markierten geänderten Zeilen. Wegklicken: nur der Plan.
 * - Verlauf-Knopf: vergangene Pläne aus PG, seitenweise.
 * Daten: GET /api/main-agent/editor/plan-strom | plan-verlauf | plan-ergebnis, Schatten über die bestehende Route /editor/schatten.
 * Anstoss: Zähler ereignisNr aus dem bestehenden SSE-Strom des Editors (je NOTIFY synapse_editor_plan), gedrosselt; Rückfall 15 s.
 * Schalter editor_plan_strom AUS: aktiv=false, ProjektEditor zeigt die Live-Pläne je Datei wie P22-T262.
 * DEBUG: data-strom, data-offen-sekunden, data-anzahl, data-verlauf an der Liste; data-zustand/data-phase je Karte; debug der Route in strom.debug.
 */
async function json(url: string): Promise<any> {
  const r = await apiFetch(url), d = await r.json();
  if (!r.ok || d.success === false) throw new Error(typeof d.error === 'string' ? d.error : d.error?.message || 'HTTP ' + r.status);
  return d;
}
const q = (v: string) => encodeURIComponent(v);
/** Höchstens so viele Schatten lädt das Detail auf einmal; weitere Dateien nennt es nur. */
const SCHATTEN_MAX_DATEIEN = 20;
/** Ops je Karte im Strom; darüber „+n weitere“. */
const OPS_SICHTBAR = 12;
const DROSSEL_MS = 200;
const RUECKFALL_MS = 15000;

type ErgebnisDatei = { file_path: string; vorher: string; nachher: string | null; nachher_quelle: 'folgeversion' | 'aktuell' | 'geloescht'; maskiert: boolean; gekuerzt: boolean };
type Schatten = { text: string | null; fehler: string | null };
const QUELLE_TEXT: Record<ErgebnisDatei['nachher_quelle'], string> = { folgeversion: 'Stand nach dem Commit', aktuell: 'aktueller Stand', geloescht: 'gelöscht' };

export interface PlanStrom {
  aktiv: boolean; live: boolean; offenMs: number;
  eintraege: Array<StromEintrag & { phase: StromPhase }>; anzahlEntstehend: number;
  offenId: string | null; offenerPlan: StromPlan | null;
  umschalten: (id: string) => void; schliessen: () => void; animationFertig: (id: string) => void;
  verlaufAn: boolean; setVerlaufAn: (an: boolean) => void; verlauf: { plaene: StromPlan[]; naechste: string | null; laedt: boolean };
  verlaufMehr: () => void; verlaufOeffnen: (p: StromPlan) => void;
  schatten: Record<string, Schatten>; ergebnis: { dateien: ErgebnisDatei[]; hinweis: string | null } | null; detailLaedt: boolean;
  debug: unknown;
}

export function usePlanStrom({ project, live, ereignisNr, onFehler }: { project: string; live: boolean; ereignisNr: number; onFehler: (text: string) => void }): PlanStrom {
  const gedaechtnis = useRef(new PlanStromGedaechtnis());
  const [aktiv, setAktiv] = useState(false), [offenSek, setOffenSek] = useState(OFFEN_STANDARD_SEKUNDEN), [debug, setDebug] = useState<unknown>(null);
  const [jetzt, setJetzt] = useState(() => Date.now()), [stand, setStand] = useState(0);
  const [offenId, setOffenId] = useState<string | null>(null), [verlaufPlan, setVerlaufPlan] = useState<StromPlan | null>(null);
  const [verlaufAn, setVerlaufAn] = useState(false), [verlauf, setVerlauf] = useState<PlanStrom['verlauf']>({ plaene: [], naechste: null, laedt: false });
  const [schatten, setSchatten] = useState<Record<string, Schatten>>({}), [ergebnis, setErgebnis] = useState<PlanStrom['ergebnis']>(null), [detailLaedt, setDetailLaedt] = useState(false);
  const fehlerRef = useRef(onFehler); fehlerRef.current = onFehler;
  const offenIdRef = useRef(offenId); offenIdRef.current = offenId;
  const ausstehend = useRef<number | null>(null);
  const offenMs = offenSek * 1000;

  const laden = useCallback(async () => {
    const d = await json('/api/main-agent/editor/plan-strom?project=' + q(project));
    setAktiv(d.aktiv === true); setDebug(d.debug ?? null);
    if (d.aktiv !== true) return;
    const s = Number(d.offen_sekunden); if (Number.isFinite(s) && s > 0) setOffenSek(s);
    const t = Date.now();
    gedaechtnis.current.aktualisiere((d.plaene ?? []) as StromPlan[], t, { vollstaendig: d.voll !== true });
    setJetzt(t); setStand(n => n + 1);
  }, [project]);

  // Projektwechsel: Gedaechtnis und Auswahl neu, erster Abruf (auch ohne Live, damit der Schalterstand bekannt ist).
  useEffect(() => {
    gedaechtnis.current = new PlanStromGedaechtnis(); setAktiv(false); setOffenId(null); setVerlaufPlan(null); setVerlaufAn(false);
    setVerlauf({ plaene: [], naechste: null, laedt: false }); setSchatten({}); setErgebnis(null);
    let lebt = true; void laden().catch(e => { if (lebt) fehlerRef.current(String(e)); });
    return () => { lebt = false; };
  }, [project, laden]);
  // Je Ereignis neu abgleichen, gedrosselt (ein Abruf je DROSSEL_MS, kein Verhungern bei Dauerfeuer).
  useEffect(() => {
    if (!live || !aktiv || !ereignisNr || ausstehend.current !== null) return;
    ausstehend.current = window.setTimeout(() => { ausstehend.current = null; void laden().catch(e => fehlerRef.current(String(e))); }, DROSSEL_MS);
  }, [ereignisNr, live, aktiv, laden]);
  useEffect(() => () => { if (ausstehend.current !== null) window.clearTimeout(ausstehend.current); }, []);
  // Rueckfall ohne Ereignisse und sofortiger Abgleich, wenn Live wieder angeht.
  useEffect(() => {
    if (!live || !aktiv) return;
    void laden().catch(() => { /* naechster Takt versucht es erneut */ });
    const t = window.setInterval(() => void laden().catch(() => { /* naechster Takt */ }), RUECKFALL_MS);
    return () => window.clearInterval(t);
  }, [live, aktiv, laden]);
  // Genau ein Timer bis zur naechsten Phasenaenderung (Ausblenden, Entfernen); nichts wird vorher abgeschnitten.
  useEffect(() => {
    const g = gedaechtnis.current, t0 = Date.now();
    g.aufraeumen(t0, offenMs, offenId);
    const n = g.naechsteAenderung(t0, offenMs, offenId);
    if (n === null) return;
    const t = window.setTimeout(() => setJetzt(Date.now()), Math.max(30, n - t0 + 10));
    return () => window.clearTimeout(t);
  }, [jetzt, stand, offenMs, offenId]);

  const schliessen = useCallback(() => {
    const id = offenIdRef.current, t = Date.now();
    if (id) gedaechtnis.current.geschlossen(id, t);
    setOffenId(null); setVerlaufPlan(null); setJetzt(t);
  }, []);
  const oeffnen = useCallback((id: string, ausVerlauf: StromPlan | null) => {
    const alt = offenIdRef.current, t = Date.now();
    if (alt && alt !== id) gedaechtnis.current.geschlossen(alt, t);
    setOffenId(id); setVerlaufPlan(ausVerlauf); setJetzt(t);
  }, []);
  const umschalten = useCallback((id: string) => { if (offenIdRef.current === id) schliessen(); else oeffnen(id, null); }, [schliessen, oeffnen]);
  const verlaufOeffnen = useCallback((p: StromPlan) => {
    if (offenIdRef.current === p.id) { schliessen(); return; }
    oeffnen(p.id, gedaechtnis.current.hole(p.id) ? null : p);
  }, [schliessen, oeffnen]);
  const animationFertig = useCallback((id: string) => { const t = Date.now(); gedaechtnis.current.animationFertig(id, t); setJetzt(t); }, []);

  const verlaufLaden = useCallback(async (vor: string | null) => {
    setVerlauf(v => ({ ...v, laedt: true }));
    try {
      const d = await json('/api/main-agent/editor/plan-verlauf?project=' + q(project) + (vor ? '&vor_id=' + q(vor) : ''));
      setVerlauf(v => ({ plaene: vor ? [...v.plaene, ...(d.plaene as StromPlan[])] : d.plaene as StromPlan[], naechste: d.naechste ?? null, laedt: false }));
    } catch (e) { setVerlauf(v => ({ ...v, laedt: false })); fehlerRef.current(String(e)); }
  }, [project]);
  useEffect(() => { if (verlaufAn && aktiv) void verlaufLaden(null); }, [verlaufAn, aktiv, verlaufLaden]);
  const verlaufMehr = useCallback(() => { if (verlauf.naechste && !verlauf.laedt) void verlaufLaden(verlauf.naechste); }, [verlauf.naechste, verlauf.laedt, verlaufLaden]);

  const offenerPlan = offenId ? gedaechtnis.current.hole(offenId)?.plan ?? (verlaufPlan?.id === offenId ? verlaufPlan : null) : null;
  // Detail: Schatten aller Dateien, solange der Plan entsteht (nur geaenderte, gedrosselt, H2); nach dem Commit einmal das Ergebnis aus PG.
  // Die zuletzt geladenen Schatten bleiben stehen („Letzter Schatten“), das Ergebnis kommt dazu.
  // H2: je Datei Signatur und Zeitpunkt des letzten Schatten-Abrufs; ein Wecker holt gedrosselte Abrufe nach.
  const schattenStand = useRef(new Map<string, { sig: string; zeit: number }>());
  const [schattenWecker, setSchattenWecker] = useState(0);
  useEffect(() => { setSchatten({}); setErgebnis(null); setDetailLaedt(false); schattenStand.current = new Map(); }, [offenId]);
  const sig = offenerPlan ? offenerPlan.id + '|' + offenerPlan.zustand + '|' + offenerPlan.ops.length : '';
  const schattenTakt = offenerPlan?.zustand === 'entsteht' ? stand : 0;
  useEffect(() => {
    const p = offenerPlan; if (!p) return;
    let lebt = true, wecker: number | null = null;
    if (p.zustand === 'entsteht') {
      // H2: nur Dateien mit geaenderten Ops (bzw. erstmals oder nach SCHATTEN_AUFFRISCHEN_MS), je Datei hoechstens 1 Abruf pro Sekunde.
      // Ergebnisse gelten, solange derselbe Plan offen ist (ein neuer Abgleich verwirft laufende Abrufe nicht).
      const t = Date.now(), sigVon = (f: string) => dateiSignatur(p, f);
      const { jetzt: faellig, naechste } = schattenFaellig(p.dateien.slice(0, SCHATTEN_MAX_DATEIEN), sigVon, schattenStand.current, t);
      if (naechste !== null) wecker = window.setTimeout(() => setSchattenWecker(n => n + 1), Math.max(50, naechste - t + 10));
      if (faellig.length) {
        for (const f of faellig) schattenStand.current.set(f, { sig: sigVon(f), zeit: t });
        setDetailLaedt(true);
        void Promise.all(faellig.map(async (f): Promise<[string, Schatten]> => {
          try {
            const d = await json('/api/main-agent/editor/schatten?project=' + q(project) + '&path=' + q(f) + '&plan=' + q(p.id));
            return [f, { text: String(d.content ?? d.file?.content ?? ''), fehler: null }];
          } catch (e) { return [f, { text: null, fehler: e instanceof Error ? e.message : String(e) }]; }
        })).then(r => { if (offenIdRef.current === p.id) setSchatten(v => ({ ...v, ...Object.fromEntries(r) })); })
          .finally(() => { if (offenIdRef.current === p.id) setDetailLaedt(false); });
      }
    } else if (p.status === 'committed') {
      setDetailLaedt(true);
      void json('/api/main-agent/editor/plan-ergebnis?project=' + q(project) + '&plan=' + q(p.id))
        .then(d => { if (lebt) setErgebnis({ dateien: (d.dateien ?? []) as ErgebnisDatei[], hinweis: d.hinweis ?? null }); })
        .catch(e => { if (lebt) fehlerRef.current(String(e)); })
        .finally(() => { if (lebt) setDetailLaedt(false); });
    }
    return () => { lebt = false; if (wecker !== null) window.clearTimeout(wecker); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sig/schattenTakt/schattenWecker fassen offenerPlan zusammen
  }, [sig, schattenTakt, schattenWecker, project]);

  const eintraege = useMemo(() => gedaechtnis.current.sichtbar(jetzt, offenMs, offenId), [jetzt, stand, offenMs, offenId]);
  return {
    aktiv, live, offenMs, eintraege, anzahlEntstehend: eintraege.filter(e => e.phase === 'entsteht').length,
    offenId, offenerPlan, umschalten, schliessen, animationFertig,
    verlaufAn, setVerlaufAn, verlauf, verlaufMehr, verlaufOeffnen, schatten, ergebnis, detailLaedt, debug,
  };
}

const opsText = (n: number) => n + (n === 1 ? ' Op' : ' Ops');
const dateienText = (n: number) => n + (n === 1 ? ' Datei' : ' Dateien');
const uhrzeit = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

function StromKarte({ e, strom, pfad }: { e: StromEintrag & { phase: StromPhase }; strom: PlanStrom; pfad: string }) {
  const p = e.plan, offen = strom.offenId === p.id, beginn = fristBeginn(e), rest = p.ops.length - OPS_SICHTBAR;
  return <li className="ed-strom-plan" data-zustand={p.zustand} data-phase={e.phase} data-offen={offen ? '' : undefined}
    data-betrifft={pfad && p.dateien.includes(pfad) ? '' : undefined}
    onAnimationEnd={ev => { if (ev.animationName === 'ed-strom-abschluss' || ev.animationName === 'ed-strom-verworfen') strom.animationFertig(p.id); }}>
    <button type="button" className="ed-strom-kopf" aria-expanded={offen} onClick={() => strom.umschalten(p.id)}
      title={offen ? 'Wegklicken: nur der Plan' : p.status === 'committed' ? 'Schatten und committete Inhalte aus PG zeigen' : 'Alle Schatten des Plans zeigen'}>
      <span className="ed-plan-wer">{p.owner_agent_id || 'unbekannt'}</span>
      <span className="ed-chip">{ZUSTAND_TEXT[p.zustand]}</span>
      <span className="ed-plan-id">Plan {p.id} · {opsText(p.ops.length)} · {dateienText(p.dateien.length)}{p.ende_am ? ' · ' + uhrzeit(p.ende_am) : ''}</span>
    </button>
    <ol className="ed-strom-ops" aria-label={'Ops von Plan ' + p.id}>
      {p.ops.slice(0, OPS_SICHTBAR).map(o => <li key={o.i} data-action={o.action} data-zustand={o.zustand ?? undefined} title={[o.file_path, o.reason].filter(Boolean).join(' · ')}>
        <span className="ed-strom-op-art" aria-hidden="true">{OP_ZEICHEN[o.action] ?? '•'}</span>
        <span className="ed-strom-op-datei">{dateiname(o.file_path)}</span>
        {o.new_path && <small>→ {dateiname(o.new_path)}</small>}
        <small className="ed-strom-op-name">{o.action}</small>
      </li>)}
      {rest > 0 && <li className="ed-strom-op-mehr">+{rest} weitere</li>}
      {!p.ops.length && <li className="ed-strom-op-mehr">noch keine Op</li>}
    </ol>
    {beginn !== null && !offen && <span key={beginn} className="ed-strom-frist" aria-hidden="true"
      style={{ '--offen-ms': strom.offenMs + 'ms', '--offen-seit': (beginn - Date.now()) + 'ms' } as CSSProperties} />}
  </li>;
}

/** Inspektor-Seite „Live-Pläne“ bei Schalter editor_plan_strom: Strom aller files-Pläne des Projekts bzw. Verlauf. */
export function PlanStromListe({ strom, pfad }: { strom: PlanStrom; pfad: string }) {
  return <div className="ed-seite ed-strom" role="tabpanel" data-strom="an" data-offen-sekunden={Math.round(strom.offenMs / 1000)}
    data-anzahl={strom.eintraege.length} data-verlauf={strom.verlaufAn ? 'an' : 'aus'}>
    <div className="ed-strom-leiste">
      <h3>{strom.verlaufAn ? 'Verlauf · Projekt' : <><i className="ed-live-punkt" aria-hidden="true" />Plan-Strom · Projekt</>}</h3>
      <button type="button" className="ed-mini" aria-pressed={strom.verlaufAn} onClick={() => strom.setVerlaufAn(!strom.verlaufAn)}
        title="Vergangene files-Pläne aus PG nachträglich ansehen"><span aria-hidden="true">↺</span> Verlauf</button>
    </div>
    {strom.verlaufAn
      ? <>
        <ol className="ed-strom-verlauf">{strom.verlauf.plaene.map(p => <li key={p.id}>
          <button type="button" data-zustand={p.zustand} aria-pressed={strom.offenId === p.id} onClick={() => strom.verlaufOeffnen(p)}>
            <span className="ed-plan-wer">{p.owner_agent_id || 'unbekannt'}</span><span className="ed-chip">{ZUSTAND_TEXT[p.zustand]}</span>
            <small>Plan {p.id} · {opsText(p.ops.length)} · {p.ende_am ? new Date(p.ende_am).toLocaleString('de-DE') : 'ohne Ende'}</small>
          </button></li>)}</ol>
        {!strom.verlauf.plaene.length && !strom.verlauf.laedt && <p className="ed-leer-text">Noch keine beendeten Pläne in diesem Projekt.</p>}
        {strom.verlauf.laedt && <p className="ed-leer-text laedt">Verlauf lädt</p>}
        {strom.verlauf.naechste && <button type="button" className="ed-knopf breit" disabled={strom.verlauf.laedt} onClick={strom.verlaufMehr}>Ältere Pläne laden</button>}
      </>
      : !strom.live
        ? <p className="ed-leer-text">Live-Ansicht aus. Oben „Pläne live“ einschalten, um den Plan-Strom zu sehen. Vergangene Pläne zeigt der Verlauf.</p>
        : <>
          <ol className="ed-strom-liste">{strom.eintraege.map(e => <StromKarte key={e.plan.id} e={e} strom={strom} pfad={pfad} />)}</ol>
          {!strom.eintraege.length && <p className="ed-leer-text">Gerade entsteht kein Plan. Neue files-Pläne der Agenten erscheinen hier, sobald sie angelegt werden.</p>}
        </>}
  </div>;
}

function ErgebnisText({ d }: { d: ErgebnisDatei }) {
  const neu = d.nachher ?? '';
  const marken = useMemo(() => geaenderteZeilen(d.vorher, neu), [d.vorher, neu]);
  const tokens = useZeilenTokens(d.file_path, neu);
  return <pre className="ed-strom-ergebnis">{neu.split('\n').map((z, i) => <span key={i} className={marken[i] ? 'anders' : undefined}><i aria-hidden="true">{i + 1}</i>{z ? <ZeilenInhalt tokens={tokens?.[i]} roh={z} /> : ' '}</span>)}</pre>;
}

/** Unteres Panel der Mitte: alle Schatten des geöffneten Plans, nach dem Commit zusätzlich die committeten Inhalte aus PG. */
export function PlanStromDetail({ strom }: { strom: PlanStrom }) {
  const p = strom.offenerPlan;
  if (!p) return null;
  const entsteht = p.zustand === 'entsteht', ergebnis = strom.ergebnis;
  const dateien = [...new Set([...p.dateien, ...(ergebnis?.dateien.map(d => d.file_path) ?? [])])];
  const ohneSchatten = entsteht ? dateien.slice(SCHATTEN_MAX_DATEIEN) : [];
  return <section className="ed-strom-detail" data-zustand={p.zustand} aria-label={'Plan ' + p.id}>
    <header>
      <span className="ed-auge">Plan {p.id}</span><strong>{p.owner_agent_id || 'unbekannt'}</strong>
      <span className="ed-chip">{ZUSTAND_TEXT[p.zustand]}</span>
      {strom.detailLaedt && <span className="ed-strom-laedt laedt">lädt</span>}
      <button type="button" className="ed-mini" onClick={strom.schliessen}>Schließen</button>
    </header>
    {p.reason && <p className="ed-strom-grund">{p.reason}</p>}
    <div className="ed-strom-dateien">
      {dateien.filter(f => !ohneSchatten.includes(f)).map(f => {
        const s = strom.schatten[f], er = ergebnis?.dateien.find(x => x.file_path === f);
        return <article key={f} className="ed-strom-datei">
          <h4 title={f}>{f}{er?.maskiert && <small>maskiert</small>}{er?.gekuerzt && <small>gekürzt</small>}</h4>
          <div className="ed-strom-spalten">
            {(entsteht || s) && <div className="ed-strom-spalte" data-art="schatten">
              <h5>{entsteht ? 'Schatten · live' : 'Letzter Schatten'}</h5>
              {s?.fehler ? <p className="ed-strom-fehlt">{s.fehler}</p> : <pre className={'ed-schatten' + (entsteht ? ' schreibt' : '')}>{s?.text ? <HervorgehobenerText pfad={f} text={s.text} /> : ''}</pre>}
            </div>}
            {er && <div className="ed-strom-spalte" data-art="committet">
              <h5>Committet · aus PG <small>{QUELLE_TEXT[er.nachher_quelle]}</small></h5>
              {er.nachher === null ? <p className="ed-strom-fehlt">Datei durch den Plan gelöscht</p> : <ErgebnisText d={er} />}
            </div>}
            {!entsteht && !s && !er && <p className="ed-leer-text">{p.status === 'committed' ? (strom.detailLaedt ? 'Inhalt lädt' : 'Keine Dateiversion in PG') : 'Nicht übernommen · ' + ZUSTAND_TEXT[p.zustand]}</p>}
          </div>
        </article>;
      })}
      {ohneSchatten.length > 0 && <p className="ed-leer-text">Weitere {dateienText(ohneSchatten.length)} ohne Schatten (mehr als {SCHATTEN_MAX_DATEIEN}): {ohneSchatten.map(dateiname).join(', ')}</p>}
      {!dateien.length && <p className="ed-leer-text">Der Plan hat noch keine Datei.</p>}
    </div>
  </section>;
}
