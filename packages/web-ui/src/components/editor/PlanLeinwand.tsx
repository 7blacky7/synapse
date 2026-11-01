import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../../api/auth';
import '../../editor-plan-leinwand-p22-t263.css';
import {
  ZUSTAND_TEXT, OP_ZEICHEN, LEINWAND_PARALLEL, anzeigeZeilen, diffStuecke, leinwandFaellig, leinwandSignatur, amEnde, verlaufAlsEintraege,
  type LeinwandDaten, type LeinwandDatei, type LeinwandNichtAnwendbar, type DiffZeile,
} from './plan-strom-logik';
import { useZeilenTokens, ZeilenInhalt } from './hervorhebung';
import type { PlanStrom } from './PlanStrom';

/*
 * P22-T263 Leinwand (User-Vorgabe thought ad8d1f41, 01.11.2026; Gestaltung claude-linde, Stil wie P22-T262/T263):
 * Ist der Explorer eingeklappt (Schalter editor_plan_leinwand), steht hier, wo sonst der Code steht, der Plan-Strom als EIN
 * durchgehender Strom, ohne Klick: aelteste oben, neueste unten; steht man unten, laeuft die Leinwand mit.
 * Je Plan ALLE Ops (nicht abgehackt) und je Datei der vollstaendige Diff: alle Hunks mit Op-Zuordnung und Syntax-Hervorhebung
 * (Schalter editor_syntax), unveraenderte Strecken aufklappbar, Umschalter „Ganze Dateien“. Nicht anwendbare Ops stehen mit Grund an
 * Op und Datei. Sichtbarkeit und Ausblenden kommen unveraendert aus dem Plan-Strom (Offen-Fenster, Abschluss nie abgeschnitten);
 * „Festhalten“ oeffnet den Plan (er bleibt, bis man ihn loest).
 * Daten: GET /api/main-agent/editor/plan-aenderungen, EIN Abruf je Plan (neu bei geaenderter Signatur, hoechstens 1/s je Plan,
 * entstehende alle 10 s aufgefrischt, LEINWAND_PARALLEL gleichzeitig); zurueckgestellte Dateien (Summen-Grenze) per Knopf mit datei=.
 * DEBUG: data-leinwand, data-plaene, data-ganz, data-folgt am Wurzelelement; data-zustand/data-phase/data-quelle/data-laedt je Plan;
 * data-neu/data-geloescht/data-zurueckgestellt je Datei; data-art je Zeile.
 */
async function json(url: string): Promise<any> {
  const r = await apiFetch(url), d = await r.json();
  if (!r.ok || d.success === false) throw new Error(typeof d.error === 'string' ? d.error : d.error?.message || 'HTTP ' + r.status);
  return d;
}
const q = (v: string) => encodeURIComponent(v);
const opsText = (n: number) => n + (n === 1 ? ' Op' : ' Ops');
const dateienText = (n: number) => n + (n === 1 ? ' Datei' : ' Dateien');
const uhrzeit = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

type Stand = { daten: LeinwandDaten | null; fehler: string | null; laedt: boolean };
type AenderungenAntwort = { dateien?: LeinwandDatei[]; nicht_anwendbar?: LeinwandNichtAnwendbar[]; quelle?: unknown; hinweise?: string[] };
const alsDaten = (d: AenderungenAntwort): LeinwandDaten => ({ dateien: d.dateien ?? [], nicht_anwendbar: d.nicht_anwendbar ?? [], quelle: String(d.quelle ?? ''), hinweise: d.hinweise ?? [] });

/** Abrufe der Leinwand: je sichtbarem Plan ein Stand; weggefallene Plaene werden vergessen. */
function useLeinwandDaten(project: string, eintraege: PlanStrom['eintraege']) {
  const [daten, setDaten] = useState<Record<string, Stand>>({});
  const stand = useRef(new Map<string, { sig: string; zeit: number }>());
  const laufend = useRef(new Set<string>());
  const nachgeladen = useRef(new Set<string>());
  const projektRef = useRef(project); projektRef.current = project;
  const [wecker, setWecker] = useState(0);
  useEffect(() => { stand.current = new Map(); laufend.current = new Set(); nachgeladen.current = new Set(); setDaten({}); }, [project]);

  const dateiNachladen = useCallback((id: string, pfad: string) => {
    const fuer = projektRef.current;
    nachgeladen.current.add(id + '|' + pfad);
    setDaten(v => (v[id] ? { ...v, [id]: { ...v[id], laedt: true } } : v));
    void json('/api/main-agent/editor/plan-aenderungen?project=' + q(fuer) + '&plan=' + q(id) + '&datei=' + q(pfad))
      .then(d => {
        const neu = (d.dateien ?? [])[0] as LeinwandDatei | undefined;
        if (projektRef.current !== fuer) return;
        setDaten(v => {
          const alt = v[id]?.daten;
          if (!alt) return v;
          return { ...v, [id]: { ...v[id], laedt: false, daten: { ...alt, dateien: neu ? alt.dateien.map(f => (f.file_path === pfad ? neu : f)) : alt.dateien } } };
        });
      })
      .catch(e => { if (projektRef.current === fuer) setDaten(v => (v[id] ? { ...v, [id]: { ...v[id], laedt: false, fehler: e instanceof Error ? e.message : String(e) } } : v)); });
  }, []);
  const neuLaden = useCallback((id: string) => { stand.current.delete(id); setWecker(n => n + 1); }, []);

  const plaene = useMemo(() => eintraege.map(e => e.plan), [eintraege]);
  const schluessel = plaene.map(p => p.id + '|' + leinwandSignatur(p)).join(';');
  useEffect(() => {
    const t = Date.now(), ids = new Set(plaene.map(p => p.id));
    for (const id of [...stand.current.keys()]) if (!ids.has(id)) stand.current.delete(id);
    setDaten(v => { const n = Object.fromEntries(Object.entries(v).filter(([k]) => ids.has(k))); return Object.keys(n).length === Object.keys(v).length ? v : n; });
    const { jetzt: faellig, naechste } = leinwandFaellig(plaene.filter(p => !laufend.current.has(p.id)), stand.current, t);
    const los = faellig.slice(0, Math.max(0, LEINWAND_PARALLEL - laufend.current.size));
    const weiter = faellig.length > los.length ? t + 250 : naechste;
    const timer = weiter === null ? null : window.setTimeout(() => setWecker(n => n + 1), Math.max(50, weiter - t + 10));
    for (const id of los) {
      const p = plaene.find(x => x.id === id);
      if (!p) continue;
      const fuer = project;
      stand.current.set(id, { sig: leinwandSignatur(p), zeit: t });
      laufend.current.add(id);
      setDaten(v => ({ ...v, [id]: { daten: v[id]?.daten ?? null, fehler: null, laedt: true } }));
      void json('/api/main-agent/editor/plan-aenderungen?project=' + q(project) + '&plan=' + q(id))
        .then(d => {
          if (projektRef.current !== fuer) return;
          const neu = alsDaten(d);
          setDaten(v => ({ ...v, [id]: { daten: neu, fehler: null, laedt: false } }));
          // Einzeln nachgeladene grosse Dateien bleiben nachgeladen, auch wenn der Plan neu kommt.
          for (const f of neu.dateien) if (f.zurueckgestellt && nachgeladen.current.has(id + '|' + f.file_path)) dateiNachladen(id, f.file_path);
        })
        .catch(e => { if (projektRef.current === fuer) setDaten(v => ({ ...v, [id]: { daten: v[id]?.daten ?? null, fehler: e instanceof Error ? e.message : String(e), laedt: false } })); })
        .finally(() => { laufend.current.delete(id); setWecker(n => n + 1); });
    }
    return () => { if (timer !== null) window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- schluessel fasst die sichtbaren Plaene samt Signatur zusammen
  }, [schluessel, wecker, project]);
  return { daten, dateiNachladen, neuLaden };
}

function DateiPfad({ pfad }: { pfad: string }) {
  const i = pfad.lastIndexOf('/');
  return <span className="ed-lw-pfad" title={pfad}>{i >= 0 && <span>{pfad.slice(0, i + 1)}</span>}<b>{pfad.slice(i + 1)}</b></span>;
}
function NichtAnwendbar({ na }: { na: LeinwandNichtAnwendbar[] }) {
  if (!na.length) return null;
  return <ul className="ed-lw-na" aria-label="Nicht anwendbare Ops">{na.map(n => <li key={n.op_index}><b>Op #{n.op_index} nicht anwendbar</b><span>{n.fehler}</span></li>)}</ul>;
}

/** Eine Datei: Kopf mit +/-, dann alle Hunks vollständig, unveränderte Strecken als aufklappbare Lücke. */
function DateiDiff({ f, na, ganz, schreibt, nachladen }: { f: LeinwandDatei; na: LeinwandNichtAnwendbar[]; ganz: boolean; schreibt: boolean; nachladen: () => void }) {
  const [offen, setOffen] = useState<ReadonlySet<string>>(() => new Set());
  const alt = useMemo(() => anzeigeZeilen(f.vorher ?? ''), [f.vorher]);
  const neu = useMemo(() => anzeigeZeilen(f.nachher ?? ''), [f.nachher]);
  const tAlt = useZeilenTokens(f.file_path, f.vorher), tNeu = useZeilenTokens(f.file_path, f.nachher);
  const stuecke = useMemo(() => (f.vorher === null ? [] : diffStuecke(f.hunks, alt.length, s => ganz || offen.has(s))), [f, alt.length, ganz, offen]);
  const zeile = (z: DiffZeile, k: number) => {
    // Neue Datei: die leere Basiszeile ist kein Entfernen; gelöschte Datei: die leere Endzeile ist kein Hinzufügen.
    if ((z.art === 'weg' && f.neu) || (z.art === 'neu' && f.nachher === null)) return null;
    const weg = z.art === 'weg', text = weg ? alt[z.a ?? 0] : neu[z.b ?? 0], tok = weg ? tAlt?.[z.a ?? 0] : tNeu?.[z.b ?? 0];
    return <div key={k} className="ed-lw-z" data-art={z.art}>
      <i>{z.a !== null ? z.a + 1 : ''}</i><i>{z.b !== null ? z.b + 1 : ''}</i><b aria-hidden="true">{weg ? '−' : z.art === 'neu' ? '+' : ''}</b>
      <code>{text ? <ZeilenInhalt tokens={tok} roh={text} /> : ' '}</code>
    </div>;
  };
  return <section className="ed-lw-datei" data-neu={f.neu ? '' : undefined} data-geloescht={f.geloescht ? '' : undefined} data-zurueckgestellt={f.zurueckgestellt ? '' : undefined}>
    <h4>
      <DateiPfad pfad={f.file_path} />
      {f.neu && <small>neu</small>}{f.geloescht && <small>gelöscht</small>}{f.maskiert && <small>maskiert</small>}{f.nur_zeilenenden && <small>nur Zeilenenden</small>}
      <span className="ed-lw-plusminus"><ins>+{f.plus}</ins><del>−{f.minus}</del></span>
      {f.ops.length > 0 && <span className="ed-lw-datei-ops">{f.ops.map(i => '#' + i).join(' ')}</span>}
    </h4>
    {f.drift && <p className="ed-lw-hinweis">{f.drift}</p>}
    <NichtAnwendbar na={na} />
    {f.zurueckgestellt
      ? <p className="ed-lw-zurueck">Großer Plan: Diese Datei kam nicht mit dem ersten Abruf.<button type="button" className="ed-mini" onClick={nachladen}>Änderungen laden</button></p>
      : f.zu_gross !== null
        ? <p className="ed-lw-zurueck">Datei zu groß für einen Zeilen-Diff ({f.zu_gross.toLocaleString('de-DE')} Zeichen). Die Ops oben nennen jede Änderung.</p>
        : <div className={'ed-lw-diff' + (schreibt ? ' schreibt' : '')} role="group" aria-label={'Änderungen ' + f.file_path}>
          {stuecke.map(s => s.art === 'luecke'
            ? <button key={'l' + s.schluessel} type="button" className="ed-lw-luecke" onClick={() => setOffen(o => new Set(o).add(s.schluessel))}
              title="Unveränderte Zeilen zeigen">⋯ {s.anzahl} unveränderte {s.anzahl === 1 ? 'Zeile' : 'Zeilen'} · {s.a0 + 1}–{s.a0 + s.anzahl}</button>
            : s.art === 'umfeld'
              ? <div key={'u' + s.schluessel} className="ed-lw-umfeld">{s.zeilen.map(zeile)}</div>
              : <div key={'h' + s.index} className="ed-lw-hunk">
                <div className="ed-lw-hunk-kopf">{s.kopf}{s.ops.length > 0 && <span>{'op ' + s.ops.join(', ')}</span>}</div>
                {s.zeilen.map(zeile)}
              </div>)}
          {!f.hunks.length && <p className="ed-lw-gleich">{f.nur_zeilenenden ? 'Nur Zeilenenden geändert (CRLF/LF).' : 'Keine Änderung in dieser Datei.'}</p>}
        </div>}
  </section>;
}

function LeinwandPlan({ e, strom, stand, ganz, nachladen, neuLaden, verlaufZu }: {
  e: PlanStrom['eintraege'][number]; strom: PlanStrom; stand: Stand | undefined; ganz: boolean;
  nachladen: (id: string, pfad: string) => void; neuLaden: (id: string) => void;
  /** Plan aus dem Verlauf (cc9c22eb): Knopf „Zuklappen“ statt „Festhalten“, keine Abschlussanimation. */
  verlaufZu?: () => void;
}) {
  const p = e.plan, offen = strom.offenId === p.id, d = stand?.daten ?? null;
  const na = d?.nicht_anwendbar ?? [], naVon = new Map(na.map(n => [n.op_index, n] as const));
  const dateien = d?.dateien ?? [];
  const ohneDiff = [...new Set(na.map(n => n.file_path))].filter(f => !dateien.some(x => x.file_path === f));
  return <article id={'ed-lw-plan-' + p.id} className="ed-lw-plan" data-zustand={p.zustand} data-phase={e.phase} data-offen={offen ? '' : undefined}
    data-laedt={stand?.laedt ? '' : undefined} data-quelle={d?.quelle || undefined} data-verlauf={verlaufZu ? '' : undefined}
    onAnimationEnd={ev => { if (ev.target === ev.currentTarget && (ev.animationName === 'ed-strom-abschluss' || ev.animationName === 'ed-strom-verworfen')) strom.animationFertig(p.id); }}>
    <header className="ed-lw-plan-kopf">
      <span className="ed-plan-wer">{p.owner_agent_id || 'unbekannt'}</span>
      <span className="ed-chip">{ZUSTAND_TEXT[p.zustand]}</span>
      <span className="ed-lw-meta">Plan {p.id} · {opsText(p.ops.length)} · {dateienText(p.dateien.length)} · {uhrzeit(p.ende_am ?? p.erstellt_am)}{d?.quelle === 'commit' ? ' · Inhalte aus PG' : ''}</span>
      {stand?.laedt && <span className="ed-strom-laedt laedt">lädt</span>}
      {verlaufZu
        ? <button type="button" className="ed-mini" onClick={verlaufZu} title="Plan im Verlauf zuklappen">Zuklappen</button>
        : <button type="button" className="ed-mini" aria-pressed={offen} onClick={() => strom.umschalten(p.id)}
          title={offen ? 'Lösen: der Plan blendet nach dem Offen-Fenster aus' : 'Festhalten: der Plan bleibt auf der Leinwand, bis du ihn löst'}>{offen ? 'Lösen' : 'Festhalten'}</button>}
    </header>
    {p.reason && <p className="ed-lw-grund">{p.reason}</p>}
    <ol className="ed-lw-ops" aria-label={'Ops von Plan ' + p.id}>
      {p.ops.map(o => {
        const n = naVon.get(o.i);
        return <li key={o.i} data-action={o.action} data-zustand={n ? 'nicht_anwendbar' : o.zustand ?? undefined}>
          <span className="ed-lw-op-nr">#{o.i}</span>
          <span className="ed-lw-op-art" aria-hidden="true">{OP_ZEICHEN[o.action] ?? '•'}</span>
          <span className="ed-lw-op-datei" title={o.file_path}>{o.file_path}</span>
          {o.new_path && <small>→ {o.new_path}</small>}
          <small className="ed-lw-op-name">{o.action}{o.agent_id && o.agent_id !== p.owner_agent_id ? ' · ' + o.agent_id : ''}</small>
          {o.reason && <span className="ed-lw-op-grund">{o.reason}</span>}
          {n && <b className="ed-lw-op-fehler">nicht anwendbar · {n.fehler}</b>}
        </li>;
      })}
      {!p.ops.length && <li className="ed-lw-op-leer">noch keine Op</li>}
    </ol>
    {stand?.fehler && <p className="ed-lw-fehler">{stand.fehler}<button type="button" className="ed-mini" onClick={() => neuLaden(p.id)}>Erneut laden</button></p>}
    {d?.hinweise.map((h, i) => <p key={i} className="ed-lw-hinweis">{h}</p>)}
    {(dateien.length > 0 || ohneDiff.length > 0) && <div className="ed-lw-dateien">
      {dateien.map(f => <DateiDiff key={f.file_path} f={f} na={na.filter(n => n.file_path === f.file_path)} ganz={ganz} schreibt={p.zustand === 'entsteht'} nachladen={() => nachladen(p.id, f.file_path)} />)}
      {ohneDiff.map(f => <section key={f} className="ed-lw-datei" data-ohne-diff=""><h4><DateiPfad pfad={f} /></h4><NichtAnwendbar na={na.filter(n => n.file_path === f)} /></section>)}
    </div>}
    {!d && !stand?.fehler && p.ops.length > 0 && <p className="ed-lw-laedt laedt">Änderungen laden</p>}
    {d && !dateien.length && !ohneDiff.length && <p className="ed-lw-laedt">{p.ops.length ? 'Keine inhaltliche Änderung' : 'Der Plan hat noch keine Op.'}</p>}
  </article>;
}

/** Mitte des Editors bei eingeklapptem Explorer: der Plan-Strom vollständig als durchgehender Strom. */
export function PlanLeinwand({ strom, project }: { strom: PlanStrom; project: string }) {
  const verlauf = strom.verlaufAn;
  const { daten, dateiNachladen, neuLaden } = useLeinwandDaten(project, strom.live && !verlauf ? strom.eintraege : []);
  // User-Entscheidung cc9c22eb: fertige Plaene verlassen die Live-Leinwand nach dem Offen-Fenster, der VERLAUF bleibt abrufbar.
  // Verlauf = abgeschlossene Plaene aus PG (plan-verlauf; derselbe Zustand wie der Verlauf-Knopf im Inspektor), je Plan aufklappbar
  // mit allen Ops und Aenderungen (plan-aenderungen, einmal je Plan). Nichts blendet im Verlauf aus.
  const [aufgeklappt, setAufgeklappt] = useState<ReadonlySet<string>>(() => new Set());
  const verlaufEintraege = useMemo(() => verlaufAlsEintraege(strom.verlauf.plaene, aufgeklappt), [strom.verlauf.plaene, aufgeklappt]);
  const vd = useLeinwandDaten(project, verlauf ? verlaufEintraege : []);
  const auf = (id: string) => setAufgeklappt((s) => new Set(s).add(id));
  const zu = (id: string) => setAufgeklappt((s) => { const n = new Set(s); n.delete(id); return n; });
  useEffect(() => { setAufgeklappt(new Set()); }, [project]);
  const [ganz, setGanz] = useState(false), [folgt, setFolgt] = useState(true);
  const fenster = useRef<HTMLDivElement>(null), folgtRef = useRef(true);
  // Strom-Reihenfolge: aelteste oben, neueste unten (wie ein Protokoll, das weiterlaeuft).
  const reihe = useMemo(() => [...strom.eintraege].reverse(), [strom.eintraege]);
  const inhalt = reihe.map(e => {
    const x = daten[e.plan.id]?.daten;
    return e.plan.id + ':' + e.plan.ops.length + ':' + (x ? x.dateien.reduce((n, f) => n + (f.nachher?.length ?? 0) + f.hunks.length, 0) : '-');
  }).join(',');
  useLayoutEffect(() => { const el = fenster.current; if (el && folgtRef.current && !verlauf) el.scrollTop = el.scrollHeight; }, [inhalt, verlauf]);
  useEffect(() => { const el = fenster.current; if (verlauf && el) el.scrollTop = 0; }, [verlauf]);
  // Klick im Verlauf des Inspektors (verlaufOeffnen setzt offenId) klappt den Plan auch auf der Leinwand auf.
  useEffect(() => {
    const id = strom.offenId;
    if (verlauf && id && strom.verlauf.plaene.some((p) => p.id === id)) setAufgeklappt((s) => (s.has(id) ? s : new Set(s).add(id)));
  }, [verlauf, strom.offenId, strom.verlauf.plaene]);
  useEffect(() => {
    if (!strom.offenId) return;
    const el = document.getElementById('ed-lw-plan-' + strom.offenId);
    if (!el) return;
    folgtRef.current = false; setFolgt(false);
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [strom.offenId]);
  const nachUnten = () => { const el = fenster.current; folgtRef.current = true; setFolgt(true); if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); };
  const verlaufListe = <div className="ed-lw-verlauf" aria-label="Verlauf abgeschlossener Pläne">
    <p className="ed-lw-verlauf-hinweis">Abgeschlossene files-Pläne aus PG, neueste zuerst. Ein Klick klappt einen Plan mit allen Ops und Änderungen auf. Er bleibt hier, auch nachdem er die Live-Leinwand verlassen hat.</p>
    {strom.verlauf.plaene.map((p) => {
      const e = verlaufEintraege.find((x) => x.plan.id === p.id);
      return e
        ? <LeinwandPlan key={p.id} e={e} strom={strom} stand={vd.daten[p.id]} ganz={ganz} nachladen={vd.dateiNachladen} neuLaden={vd.neuLaden} verlaufZu={() => zu(p.id)} />
        : <button key={p.id} id={'ed-lw-plan-' + p.id} type="button" className="ed-lw-verlauf-zeile" data-zustand={p.zustand} aria-expanded={false} onClick={() => auf(p.id)}
          title="Plan mit allen Ops und Änderungen aufklappen">
          <span className="ed-plan-wer">{p.owner_agent_id || 'unbekannt'}</span><span className="ed-chip">{ZUSTAND_TEXT[p.zustand]}</span>
          <span className="ed-lw-meta">Plan {p.id} · {opsText(p.ops.length)} · {dateienText(p.dateien.length)} · {p.ende_am ? new Date(p.ende_am).toLocaleString('de-DE') : 'ohne Ende'}</span>
          <span className="ed-lw-verlauf-auf" aria-hidden="true">▸</span></button>;
    })}
    {!strom.verlauf.plaene.length && !strom.verlauf.laedt && <p className="ed-lw-verlauf-hinweis">Noch keine abgeschlossenen Pläne in diesem Projekt.</p>}
    {strom.verlauf.laedt && <p className="ed-lw-laedt laedt">Verlauf lädt</p>}
    {strom.verlauf.naechste && <button type="button" className="ed-knopf breit" disabled={strom.verlauf.laedt} onClick={strom.verlaufMehr}>Ältere Pläne laden</button>}
  </div>;
  return <section className="ed-lw" aria-label="Plan-Strom auf der Leinwand" data-leinwand="an" data-plaene={reihe.length} data-ganz={ganz ? 'an' : 'aus'} data-folgt={folgt ? 'an' : 'aus'} data-verlauf={verlauf ? 'an' : 'aus'}>
    <header className="ed-lw-kopf">
      <span className="ed-auge">{verlauf ? 'Verlauf · Leinwand' : <><i className="ed-live-punkt" aria-hidden="true" />Plan-Strom · Leinwand</>}</span>
      <span className="ed-lw-zahl">{verlauf ? strom.verlauf.plaene.length + (strom.verlauf.plaene.length === 1 ? ' abgeschlossener Plan' : ' abgeschlossene Pläne') + (strom.verlauf.naechste ? ' (weitere ältere)' : '')
        : strom.live ? strom.anzahlEntstehend + ' entsteht · ' + reihe.length + (reihe.length === 1 ? ' Plan' : ' Pläne') : 'Pläne live aus'}</span>
      <button type="button" className="ed-mini" aria-pressed={verlauf} onClick={() => strom.setVerlaufAn(!verlauf)}
        title={verlauf ? 'Zurück zum Live-Strom' : 'Abgeschlossene Pläne samt Änderungen aus PG ansehen'}><span aria-hidden="true">↺</span> Verlauf</button>
      <button type="button" className="ed-mini" aria-pressed={ganz} onClick={() => setGanz(v => !v)} title="Unveränderte Zeilen aller Dateien ausklappen">Ganze Dateien</button>
    </header>
    <div className="ed-lw-fenster" ref={fenster}
      onScroll={ev => { const el = ev.currentTarget, an = amEnde(el.scrollHeight, el.scrollTop, el.clientHeight); if (an !== folgtRef.current) { folgtRef.current = an; setFolgt(an); } }}>
      {verlauf ? verlaufListe : !strom.live
        ? <div className="ed-lw-leer"><strong>Pläne live aus</strong><p>Oben „Pläne live“ einschalten. Dann erscheinen die files-Pläne der Agenten hier mit allen Änderungen, sobald sie entstehen.</p></div>
        : !reihe.length
          ? <div className="ed-lw-leer"><strong>Kein Plan im Strom</strong><p>Sobald ein Agent einen files-Plan anlegt, erscheint er hier mit allen Ops und Änderungen. Abgeschlossene Pläne findest du unter „Verlauf“; der Pfeil links blendet den Explorer wieder ein.</p></div>
          : reihe.map(e => <LeinwandPlan key={e.plan.id} e={e} strom={strom} stand={daten[e.plan.id]} ganz={ganz} nachladen={dateiNachladen} neuLaden={neuLaden} />)}
    </div>
    {!verlauf && !folgt && reihe.length > 0 && <button type="button" className="ed-lw-nach-unten" onClick={nachUnten}><span aria-hidden="true">↓</span>Zum neuesten Plan</button>}
  </section>;
}
