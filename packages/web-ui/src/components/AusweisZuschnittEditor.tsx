/**
 * P22-T68: Formular fuer das Werkzeugprofil (Zuschnitt) eines Profils - ohne JSON-Feld.
 * Felder wie ProfilZuschnitt im Backend: standard, tools, aktionen, schreiben, shell_stufe_max, limits; intern_user_festgelegt bleibt
 * unveraendert erhalten (nur mit ausdruecklichem User-Auftrag setzbar, hier nicht bearbeitbar). Die Pruefung macht das Backend.
 */
export type Regel = 'erlaubt' | 'verweigert';
export interface RegelZeile { key: string; regel: Regel }
export interface ZuschnittEntwurf {
  standard: '' | Regel;
  schreiben: '' | 'ja' | 'nein';
  shell: string;
  tools: RegelZeile[];
  aktionen: RegelZeile[];
  limits: Array<{ key: string; wert: string }>;
}

const SHELL_STUFEN = ['', 'laeuft', 'hinweis', 'anleitung', 'rueckfrage'];

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const regelZeilen = (v: unknown): RegelZeile[] => Object.entries(obj(v)).filter(([, r]) => r === 'erlaubt' || r === 'verweigert').map(([key, r]) => ({ key, regel: r as Regel }));

export function entwurfAusZuschnitt(roh: Record<string, unknown>): ZuschnittEntwurf {
  return {
    standard: roh.standard === 'erlaubt' || roh.standard === 'verweigert' ? roh.standard : '',
    schreiben: roh.schreiben === true ? 'ja' : roh.schreiben === false ? 'nein' : '',
    shell: typeof roh.shell_stufe_max === 'string' ? roh.shell_stufe_max : '',
    tools: regelZeilen(roh.tools),
    aktionen: regelZeilen(roh.aktionen),
    limits: Object.entries(obj(roh.limits)).filter(([, w]) => typeof w === 'number').map(([key, w]) => ({ key, wert: String(w) })),
  };
}

/** Baut den Zuschnitt aus dem Entwurf; unbekannte Felder der Basis (z. B. intern_user_festgelegt) bleiben erhalten. */
export function zuschnittAusEntwurf(e: ZuschnittEntwurf, basis: Record<string, unknown>): Record<string, unknown> {
  const aus: Record<string, unknown> = {};
  if (e.standard) aus.standard = e.standard;
  const tools = Object.fromEntries(e.tools.filter((z) => z.key.trim()).map((z) => [z.key.trim(), z.regel]));
  if (Object.keys(tools).length) aus.tools = tools;
  const aktionen = Object.fromEntries(e.aktionen.filter((z) => z.key.trim()).map((z) => [z.key.trim(), z.regel]));
  if (Object.keys(aktionen).length) aus.aktionen = aktionen;
  if (e.schreiben) aus.schreiben = e.schreiben === 'ja';
  if (e.shell) aus.shell_stufe_max = e.shell;
  const limits = Object.fromEntries(e.limits.filter((z) => z.key.trim() && z.wert.trim() !== '' && Number.isFinite(Number(z.wert))).map((z) => [z.key.trim(), Number(z.wert)]));
  if (Object.keys(limits).length) aus.limits = limits;
  if (basis.intern_user_festgelegt) aus.intern_user_festgelegt = basis.intern_user_festgelegt;
  return aus;
}

export function zuschnittGeaendert(e: ZuschnittEntwurf, basis: Record<string, unknown>): boolean {
  return JSON.stringify(zuschnittAusEntwurf(e, basis)) !== JSON.stringify(zuschnittAusEntwurf(entwurfAusZuschnitt(basis), basis));
}

function Regelliste({ titel, hinweis, zeilen, platzhalter, onChange }: { titel: string; hinweis: string; zeilen: RegelZeile[]; platzhalter: string; onChange: (z: RegelZeile[]) => void }) {
  return <fieldset className="breit"><legend>{titel}</legend><small>{hinweis}</small>
    {zeilen.map((z, i) => <div className="av-regelzeile" key={i}>
      <input value={z.key} placeholder={platzhalter} onChange={(e) => onChange(zeilen.map((x, n) => (n === i ? { ...x, key: e.target.value } : x)))} />
      <select value={z.regel} onChange={(e) => onChange(zeilen.map((x, n) => (n === i ? { ...x, regel: e.target.value as Regel } : x)))}><option value="erlaubt">erlaubt</option><option value="verweigert">verweigert</option></select>
      <button type="button" onClick={() => onChange(zeilen.filter((_, n) => n !== i))}>Entfernen</button>
    </div>)}
    <button type="button" onClick={() => onChange([...zeilen, { key: '', regel: 'verweigert' }])}>Zeile hinzufuegen</button>
  </fieldset>;
}

export function AusweisZuschnittEditor({ wert, onChange }: { wert: ZuschnittEntwurf; onChange: (w: ZuschnittEntwurf) => void }) {
  return <fieldset className="breit av-zuschnitt"><legend>Werkzeugprofil (Zuschnitt)</legend>
    <small>Ein Zuschnitt erweitert nie Rechte, er schraenkt nur ein. Leer = keine Einschraenkung aus dem Profil.</small>
    <div className="av-formular">
      <label>Standard fuer alle Tools<select value={wert.standard} onChange={(e) => onChange({ ...wert, standard: e.target.value as ZuschnittEntwurf['standard'] })}><option value="">nicht gesetzt</option><option value="erlaubt">erlaubt</option><option value="verweigert">verweigert</option></select></label>
      <label>Schreiben<select value={wert.schreiben} onChange={(e) => onChange({ ...wert, schreiben: e.target.value as ZuschnittEntwurf['schreiben'] })}><option value="">nicht gesetzt</option><option value="ja">erlaubt</option><option value="nein">gesperrt</option></select></label>
      <label>Hoechste Shell-Stufe<select value={wert.shell} onChange={(e) => onChange({ ...wert, shell: e.target.value })}>{SHELL_STUFEN.map((s) => <option key={s} value={s}>{s || 'nicht gesetzt'}</option>)}</select></label>
    </div>
    <Regelliste titel="Tools" hinweis="Schluessel = Tool-Name, z. B. shell oder files." zeilen={wert.tools} platzhalter="Tool" onChange={(tools) => onChange({ ...wert, tools })} />
    <Regelliste titel="Aktionen" hinweis="Schluessel = tool.action, z. B. files.delete." zeilen={wert.aktionen} platzhalter="tool.action" onChange={(aktionen) => onChange({ ...wert, aktionen })} />
    <fieldset className="breit"><legend>Limits</legend><small>Schluessel = tool.action.parameter, Wert = Zahl.</small>
      {wert.limits.map((z, i) => <div className="av-regelzeile" key={i}>
        <input value={z.key} placeholder="tool.action.parameter" onChange={(e) => onChange({ ...wert, limits: wert.limits.map((x, n) => (n === i ? { ...x, key: e.target.value } : x)) })} />
        <input value={z.wert} inputMode="numeric" placeholder="Zahl" onChange={(e) => onChange({ ...wert, limits: wert.limits.map((x, n) => (n === i ? { ...x, wert: e.target.value } : x)) })} />
        <button type="button" onClick={() => onChange({ ...wert, limits: wert.limits.filter((_, n) => n !== i) })}>Entfernen</button>
      </div>)}
      <button type="button" onClick={() => onChange({ ...wert, limits: [...wert.limits, { key: '', wert: '' }] })}>Zeile hinzufuegen</button>
    </fieldset>
  </fieldset>;
}
