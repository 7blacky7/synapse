import React from 'react';
import {
  AusweisFehler,
  aendereTyp,
  ladePersonaVersionen,
  ladePersonaVorlagen,
  ladeTypInhalt,
  ladeTypen,
  legePersonaAn,
  legeTypAn,
  neuePersonaVersion,
  type HinweisKatalogZeile,
  type PersonaVorlageZeile,
  type TypInhaltStand,
  type TypZeile,
} from '../api/ausweis-verwaltung';
import { AusweisHinweiseEditor } from './AusweisHinweiseEditor';
import { AusweisZuschnittEditor } from './AusweisZuschnittEditor';
import { inhaltAusEntwurf, inhaltEntwurf, type InhaltEntwurf } from './ausweis-inhalt';

/**
 * P22-T68: Typkatalog und Persona-Bibliothek anlegen und bearbeiten (Formulare statt JSON). Typ: typ_anlegen / typ_aendern (CAS ueber die
 * Revision, Grund Pflicht); Persona: persona_anlegen / persona_neue_version (User-Auftrag). Rechte entscheidet das Backend wie bei fuehreW1bAdminAus
 * (globale Typen/Vorlagen: nur User laut Backend).
 */
function fehlerText(error: unknown): string {
  return error instanceof AusweisFehler ? error.message : error instanceof Error ? error.message : String(error);
}

const KONTEXT_STUFEN = ['', 'normal', 'kompakt', 'minimal'];

function InhaltFormular({ wert, onChange, hinweisKatalog }: { wert: InhaltEntwurf; onChange: (w: InhaltEntwurf) => void; hinweisKatalog: HinweisKatalogZeile[] }) {
  return <div className="av-formular">
    <label>Modell<input value={wert.modell} onChange={(e) => onChange({ ...wert, modell: e.target.value })} placeholder="leer = Standard" /></label>
    <label>Effort<input value={wert.effort} onChange={(e) => onChange({ ...wert, effort: e.target.value })} placeholder="leer = Standard" /></label>
    <label>Kontextstufe<select value={wert.kontextStufe} onChange={(e) => onChange({ ...wert, kontextStufe: e.target.value })}>{KONTEXT_STUFEN.map((s) => <option key={s} value={s}>{s || 'Standard'}</option>)}</select></label>
    <label className="breit">Regeln (eine pro Zeile)<textarea rows={3} value={wert.regeln} onChange={(e) => onChange({ ...wert, regeln: e.target.value })} /></label>
    <label className="breit">Skills (einer pro Zeile)<textarea rows={2} value={wert.skills} onChange={(e) => onChange({ ...wert, skills: e.target.value })} /></label>
    <label className="breit">Channels (kommagetrennt)<input value={wert.channels} onChange={(e) => onChange({ ...wert, channels: e.target.value })} /></label>
    <label className="breit">Briefing<textarea rows={2} value={wert.briefing} onChange={(e) => onChange({ ...wert, briefing: e.target.value })} /></label>
    <label className="breit">Arbeitsweise<textarea rows={2} value={wert.arbeitsweise} onChange={(e) => onChange({ ...wert, arbeitsweise: e.target.value })} /></label>
    <AusweisZuschnittEditor wert={wert.zuschnitt} onChange={(zuschnitt) => onChange({ ...wert, zuschnitt })} />
    <AusweisHinweiseEditor katalog={hinweisKatalog} wert={wert.hinweise} onChange={(hinweise) => onChange({ ...wert, hinweise })} />
  </div>;
}

// ───────────── Typkatalog ─────────────

function TypVerwaltung({ project, grund, hinweisKatalog }: { project: string; grund: string; hinweisKatalog: HinweisKatalogZeile[] }) {
  const [typen, setTypen] = React.useState<TypZeile[]>([]);
  const [auswahl, setAuswahl] = React.useState('');
  const [stand, setStand] = React.useState<TypInhaltStand | null>(null);
  const [entwurf, setEntwurf] = React.useState<InhaltEntwurf>(() => inhaltEntwurf({}));
  const [neu, setNeu] = React.useState(false);
  const [schluessel, setSchluessel] = React.useState('');
  const [scope, setScope] = React.useState<'projekt' | 'global'>('projekt');
  const [busy, setBusy] = React.useState(false);
  const [fehler, setFehler] = React.useState('');
  const [meldung, setMeldung] = React.useState('');
  const grundOk = grund.trim().length >= 5;

  const lade = React.useCallback(async () => {
    try { setTypen(await ladeTypen(project)); } catch (e) { setTypen([]); setFehler(fehlerText(e)); }
  }, [project]);
  React.useEffect(() => { setAuswahl(''); setStand(null); setNeu(false); void lade(); }, [lade]);

  React.useEffect(() => {
    if (!auswahl || neu) return;
    let aktiv = true;
    setFehler('');
    ladeTypInhalt(project, auswahl)
      .then((s) => { if (aktiv) { setStand(s); setEntwurf(inhaltEntwurf(s.inhalt)); } })
      .catch((e) => { if (aktiv) { setStand(null); setFehler(fehlerText(e)); } });
    return () => { aktiv = false; };
  }, [project, auswahl, neu]);

  const ausfuehren = async (aktion: () => Promise<string>) => {
    setBusy(true); setFehler(''); setMeldung('');
    try { setMeldung(await aktion()); await lade(); } catch (e) { setFehler(fehlerText(e)); } finally { setBusy(false); }
  };

  const anlegen = () => ausfuehren(async () => {
    await legeTypAn(project, { scope, schluessel: schluessel.trim(), inhalt: inhaltAusEntwurf(entwurf, {}), grund });
    const name = schluessel.trim();
    setNeu(false); setSchluessel('');
    return 'Typ "' + name + '" angelegt.';
  });

  const speichern = () => ausfuehren(async () => {
    if (!stand) return '';
    await aendereTyp(project, stand.typId, stand.revision, inhaltAusEntwurf(entwurf, stand.inhalt), grund);
    const s = await ladeTypInhalt(project, stand.typId);
    setStand(s); setEntwurf(inhaltEntwurf(s.inhalt));
    return 'Typ gespeichert (Revision ' + s.revision + '). Profile mit diesem Typ erben die neue Revision.';
  });

  return <section className="av-katalog">
    <h4>Typkatalog</h4>
    <div className="av-regelzeile">
      <select value={neu ? '' : auswahl} onChange={(e) => { setNeu(false); setAuswahl(e.target.value); }}><option value="">Typ waehlen …</option>{typen.map((t) => <option key={t.id} value={t.id}>{t.schluessel + ' (' + t.scope + ', Rev. ' + t.revision + ')'}</option>)}</select>
      <button type="button" onClick={() => { setNeu(true); setAuswahl(''); setStand(null); setEntwurf(inhaltEntwurf({})); }}>Neuer Typ</button>
    </div>
    {neu && <div className="av-formular">
      <label>Schluessel<input value={schluessel} onChange={(e) => setSchluessel(e.target.value)} placeholder="z. B. reviewer" /></label>
      <label>Ebene<select value={scope} onChange={(e) => setScope(e.target.value as 'projekt' | 'global')}><option value="projekt">Projekt</option><option value="global">global (nur User)</option></select></label>
    </div>}
    {(neu || stand) && <>
      <InhaltFormular wert={entwurf} onChange={setEntwurf} hinweisKatalog={hinweisKatalog} />
      <div className="av-aktionen">
        {neu
          ? <button type="button" disabled={busy || !grundOk || !schluessel.trim()} onClick={() => void anlegen()}>Typ anlegen</button>
          : <button type="button" disabled={busy || !grundOk} onClick={() => void speichern()}>Neue Typ-Revision speichern</button>}
      </div>
      {!grundOk && <p className="av-leer">Oben einen Grund eintragen (mindestens 5 Zeichen).</p>}
    </>}
    {fehler && <p className="av-fehler" role="alert">{fehler}</p>}
    {meldung && <p className="av-meldung">{meldung}</p>}
  </section>;
}

// ───────────── Persona-Bibliothek ─────────────

interface Eigenschaft { key: string; text: string; original?: unknown }

function eigenschaften(inhalt: Record<string, unknown>): Eigenschaft[] {
  return Object.entries(inhalt).map(([key, wert]) => (typeof wert === 'string' ? { key, text: wert } : { key, text: JSON.stringify(wert), original: wert }));
}

function inhaltAusEigenschaften(zeilen: Eigenschaft[]): Record<string, unknown> {
  return Object.fromEntries(zeilen.filter((z) => z.key.trim() && z.text.trim()).map((z) => [z.key.trim(), z.original !== undefined && JSON.stringify(z.original) === z.text ? z.original : z.text]));
}

function PersonaVerwaltung({ project }: { project: string }) {
  const [vorlagen, setVorlagen] = React.useState<PersonaVorlageZeile[]>([]);
  const [auswahl, setAuswahl] = React.useState('');
  const [version, setVersion] = React.useState(0);
  const [zeilen, setZeilen] = React.useState<Eigenschaft[]>([]);
  const [neu, setNeu] = React.useState(false);
  const [name, setName] = React.useState('');
  const [scope, setScope] = React.useState<'projekt' | 'global'>('projekt');
  const [userAuftrag, setUserAuftrag] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [fehler, setFehler] = React.useState('');
  const [meldung, setMeldung] = React.useState('');

  const lade = React.useCallback(async () => {
    try { setVorlagen(await ladePersonaVorlagen(project)); } catch (e) { setVorlagen([]); setFehler(fehlerText(e)); }
  }, [project]);
  React.useEffect(() => { setAuswahl(''); setNeu(false); void lade(); }, [lade]);

  React.useEffect(() => {
    if (!auswahl || neu) return;
    let aktiv = true;
    setFehler('');
    ladePersonaVersionen(project, auswahl)
      .then((v) => { if (aktiv) { setVersion(v[0]?.version ?? 0); setZeilen(eigenschaften(v[0]?.inhalt ?? {})); } })
      .catch((e) => { if (aktiv) setFehler(fehlerText(e)); });
    return () => { aktiv = false; };
  }, [project, auswahl, neu]);

  const ausfuehren = async (aktion: () => Promise<string>) => {
    setBusy(true); setFehler(''); setMeldung('');
    try { setMeldung(await aktion()); await lade(); } catch (e) { setFehler(fehlerText(e)); } finally { setBusy(false); }
  };

  const inhalt = inhaltAusEigenschaften(zeilen);
  const hatInhalt = Object.keys(inhalt).length > 0;

  const anlegen = () => ausfuehren(async () => {
    await legePersonaAn(project, { scope, name: name.trim(), inhalt, userAuftrag });
    const n = name.trim();
    setNeu(false); setName('');
    return 'Persona-Vorlage "' + n + '" angelegt (Version 1).';
  });
  const neueVersion = () => ausfuehren(async () => {
    await neuePersonaVersion(project, auswahl, inhalt, userAuftrag);
    const v = await ladePersonaVersionen(project, auswahl);
    setVersion(v[0]?.version ?? 0);
    return 'Neue Persona-Version ' + (v[0]?.version ?? '') + ' gespeichert. Laufende Zuweisungen bleiben bei ihrer Version.';
  });

  return <section className="av-katalog">
    <h4>Persona-Bibliothek</h4>
    <div className="av-regelzeile">
      <select value={neu ? '' : auswahl} onChange={(e) => { setNeu(false); setAuswahl(e.target.value); }}><option value="">Vorlage waehlen …</option>{vorlagen.map((v) => <option key={v.id} value={v.id}>{v.name + ' (' + v.scope + ', v' + v.version + ')'}</option>)}</select>
      <button type="button" onClick={() => { setNeu(true); setAuswahl(''); setZeilen([{ key: 'stil', text: '' }]); }}>Neue Vorlage</button>
    </div>
    {neu && <div className="av-formular">
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. knapp" /></label>
      <label>Ebene<select value={scope} onChange={(e) => setScope(e.target.value as 'projekt' | 'global')}><option value="projekt">Projekt</option><option value="global">global (nur User)</option></select></label>
    </div>}
    {(neu || auswahl) && <>
      <small className="av-leer">{neu ? 'Eigenschaften der Persona (Name und Text), z. B. stil, ton, anrede.' : 'Aktuelle Version ' + version + ' – Aenderungen werden eine neue Version.'}</small>
      {zeilen.map((z, i) => <div className="av-regelzeile" key={i}>
        <input value={z.key} placeholder="Eigenschaft" onChange={(e) => setZeilen(zeilen.map((x, n) => (n === i ? { ...x, key: e.target.value } : x)))} />
        <input value={z.text} placeholder="Text" onChange={(e) => setZeilen(zeilen.map((x, n) => (n === i ? { ...x, text: e.target.value } : x)))} />
        <button type="button" onClick={() => setZeilen(zeilen.filter((_, n) => n !== i))}>Entfernen</button>
      </div>)}
      <div className="av-aktionen"><button type="button" onClick={() => setZeilen([...zeilen, { key: '', text: '' }])}>Eigenschaft hinzufuegen</button></div>
      <div className="av-formular"><label className="breit">User-Auftrag (Wortlaut)<input value={userAuftrag} onChange={(e) => setUserAuftrag(e.target.value)} placeholder="nur noetig, wenn nicht als User angemeldet" /></label></div>
      <div className="av-aktionen">
        {neu
          ? <button type="button" disabled={busy || !name.trim() || !hatInhalt} onClick={() => void anlegen()}>Vorlage anlegen</button>
          : <button type="button" disabled={busy || !hatInhalt} onClick={() => void neueVersion()}>Neue Version speichern</button>}
      </div>
    </>}
    {fehler && <p className="av-fehler" role="alert">{fehler}</p>}
    {meldung && <p className="av-meldung">{meldung}</p>}
  </section>;
}

export function AusweisKatalogeVerwaltung({ project, grund, hinweisKatalog }: { project: string; grund: string; hinweisKatalog: HinweisKatalogZeile[] }) {
  return <div className="av-kataloge">
    <TypVerwaltung project={project} grund={grund} hinweisKatalog={hinweisKatalog} />
    <PersonaVerwaltung project={project} />
  </div>;
}
