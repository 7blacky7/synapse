import React from 'react';
import type { HinweisKatalogZeile } from '../api/ausweis-verwaltung';
import type { HinweisWahl } from './ausweis-inhalt';

/**
 * P22-T68: Hinweisarten je Profil/Typ: Standard / an / aus. Pflichtarten sind im Backend nicht abschaltbar und hier nur angezeigt.
 * Gespeichert wird nur, was ausdruecklich gewaehlt ist (ProfilInhalt.hinweise); die Pruefung macht das Backend.
 */
export function AusweisHinweiseEditor({ katalog, wert, onChange }: { katalog: HinweisKatalogZeile[]; wert: Record<string, HinweisWahl>; onChange: (w: Record<string, HinweisWahl>) => void }) {
  const [filter, setFilter] = React.useState('');
  const sichtbar = katalog.filter((e) => !filter.trim() || (e.schluessel + ' ' + e.zweck).toLowerCase().includes(filter.trim().toLowerCase()));
  const gesetzt = Object.values(wert).filter((v) => v === 'an' || v === 'aus').length;
  if (!katalog.length) return <fieldset className="breit"><legend>Hinweisarten</legend><small>Der Hinweiskatalog ist nicht verfuegbar.</small></fieldset>;
  return <fieldset className="breit av-hinweise"><legend>Hinweisarten ({gesetzt} gesetzt)</legend>
    <small>Standard = Verhalten laut Katalog. Pflichtarten (immer an) sind nicht abschaltbar.</small>
    <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Hinweisarten filtern" />
    <div className="av-hinweisliste">{sichtbar.map((e) => <div className="av-regelzeile" key={e.schluessel}>
      <span className="av-bindung-task"><b>{e.schluessel}</b> <small>{e.klasse === 'pflicht' ? 'Pflicht' : e.standard ? 'Standard an' : 'Standard aus'} · {e.zweck}</small></span>
      {e.klasse === 'pflicht'
        ? <span className="av-chip">immer an</span>
        : <select value={wert[e.schluessel] ?? ''} onChange={(ev) => onChange({ ...wert, [e.schluessel]: ev.target.value as HinweisWahl })}><option value="">Standard</option><option value="an">an</option><option value="aus">aus</option></select>}
    </div>)}</div>
  </fieldset>;
}
