import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listModels,
  listProviders,
  setAllowed,
  probeProvider,
  refreshCatalog,
  listCooldowns,
  clearCooldowns,
  type CostClass,
  type PoolModel,
  type PoolProvider,
  type PoolCooldown,
} from '../api/model-pool';
import '../model-pool.css';

type SortKey = 'context' | 'name' | 'price';

/**
 * Zeigt alle erkannten Modelle nebeneinander — auch gesperrte und nicht
 * freigegebene. Das ist Absicht: man kann nicht freigeben, was man nicht sieht.
 */
export function ModelPoolTable() {
  const [models, setModels] = useState<PoolModel[]>([]);
  const [providers, setProviders] = useState<PoolProvider[]>([]);
  const [cooldowns, setCooldowns] = useState<PoolCooldown[]>([]);
  const [cost, setCost] = useState<CostClass | 'any'>('any');
  const [provider, setProvider] = useState('');
  const [query, setQuery] = useState('');
  const [minContext, setMinContext] = useState(0);
  const [needsTools, setNeedsTools] = useState(false);
  const [sort, setSort] = useState<SortKey>('context');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fetchedAt, setFetchedAt] = useState('');

  const laden = useCallback(async () => {
    try {
      const [modelle, anbieter, sperren] = await Promise.all([listModels({ sort, limit: 800 }), listProviders(), listCooldowns()]);
      setModels(modelle.models);
      setProviders(anbieter.providers);
      setCooldowns(sperren.cooldowns);
      setFetchedAt(modelle.fetchedAt);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [sort]);

  useEffect(() => { void laden(); }, [laden]);

  const fuehreAus = async (label: string, aktion: () => Promise<unknown>) => {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await aktion();
      await laden();
      setNotice(label + ' abgeschlossen.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy('');
    }
  };

  // Gefiltert wird im Browser: die Liste ist klein genug, und so reagieren
  // Filter ohne Rundreise zum Server.
  const sichtbar = useMemo(() => {
    const suche = query.trim().toLowerCase();
    return models.filter((modell) => {
      if (cost !== 'any' && modell.costClass !== cost) return false;
      if (provider && modell.provider !== provider) return false;
      if (minContext && (modell.contextLength ?? 0) < minContext) return false;
      if (needsTools && !modell.capabilities.includes('tools')) return false;
      if (suche && !(modell.ref + ' ' + (modell.name ?? '')).toLowerCase().includes(suche)) return false;
      return true;
    });
  }, [models, cost, provider, query, minContext, needsTools]);

  const zaehler = useMemo(() => ({
    frei: models.filter((m) => m.costClass === 'free').length,
    erlaubt: models.filter((m) => m.allowed).length,
    freigegeben: models.filter((m) => m.allowedSource === 'explicit' && m.allowed).length,
    gesperrt: models.filter((m) => m.allowedSource === 'explicit' && !m.allowed).length,
  }), [models]);

  const preis = (modell: PoolModel): string => {
    if (modell.costClass === 'free') return 'kostenlos';
    if (modell.priceInPerMTok === null) return '—';
    return modell.priceInPerMTok.toFixed(2) + ' / ' + (modell.priceOutPerMTok ?? 0).toFixed(2);
  };

  const zustand = (modell: PoolModel): { klasse: string; text: string } => {
    if (modell.cooldownUntil) return { klasse: 'cooling', text: 'Sperre bis ' + modell.cooldownUntil.slice(11, 16) };
    if (modell.reachability === 'blocked') return { klasse: 'blocked', text: 'nicht aufrufbar' };
    if (modell.reachability === 'no_credential') return { klasse: 'blocked', text: 'kein Zugang' };
    if (modell.reachability === 'unverified') return { klasse: 'unverified', text: 'ungeprüft' };
    return { klasse: 'ready', text: 'bereit' };
  };

  const kopf = (schluessel: SortKey, beschriftung: string) =>
    <button type="button" className={'mp-sort' + (sort === schluessel ? ' active' : '')} onClick={() => setSort(schluessel)}>{beschriftung}</button>;

  return <section className="model-pool">
    <header className="mp-head">
      <div>
        <span>MODELL-POOL · FP-1</span>
        <h3>Verfügbare Modelle</h3>
        <p>
          {models.length} erkannt · {zaehler.frei} kostenlos · {zaehler.erlaubt} nutzbar
          {zaehler.freigegeben ? ' · ' + zaehler.freigegeben + ' ausdrücklich freigegeben' : ''}
          {zaehler.gesperrt ? ' · ' + zaehler.gesperrt + ' gesperrt' : ''}
          {fetchedAt ? ' · Stand ' + fetchedAt.slice(11, 19) : ''}
        </p>
      </div>
      <div className="mp-head-actions">
        <button type="button" disabled={!!busy} onClick={() => void fuehreAus('Katalogabgleich', refreshCatalog)}>
          {busy === 'Katalogabgleich' ? 'wird geholt …' : 'Katalog neu holen'}
        </button>
        {cooldowns.length > 0 && <button type="button" disabled={!!busy} onClick={() => void fuehreAus('Sperren aufheben', clearCooldowns)}>
          {cooldowns.length} Sperre{cooldowns.length === 1 ? '' : 'n'} aufheben
        </button>}
      </div>
    </header>

    <div className="mp-providers">
      {providers.map((anbieter) => <article key={anbieter.id} className={'mp-provider ' + anbieter.reachability}>
        <i />
        <span>
          <strong>{anbieter.label}</strong>
          <small>
            {anbieter.freeCount} kostenlos von {anbieter.modelCount}
            {anbieter.credentialPresent ? '' : anbieter.envVar ? ' · Zugang fehlt' : ' · ohne Zugang nutzbar'}
          </small>
        </span>
        <button type="button" disabled={!!busy} onClick={() => void fuehreAus('Prüfung ' + anbieter.label, () => probeProvider(anbieter.id))}>
          {busy === 'Prüfung ' + anbieter.label ? 'prüft …' : 'prüfen'}
        </button>
      </article>)}
    </div>

    {error && <p className="mp-error">{error}</p>}
    {notice && !error && <p className="mp-notice">{notice}</p>}

    <div className="mp-filters">
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Modell suchen …" />
      <select value={cost} onChange={(event) => setCost(event.target.value as CostClass | 'any')}>
        <option value="any">alle Kosten</option>
        <option value="free">nur kostenlose</option>
        <option value="paid">nur kostenpflichtige</option>
        <option value="unknown">unbekannte Kosten</option>
      </select>
      <select value={provider} onChange={(event) => setProvider(event.target.value)}>
        <option value="">alle Anbieter</option>
        {providers.map((anbieter) => <option key={anbieter.id} value={anbieter.id}>{anbieter.label}</option>)}
      </select>
      <select value={minContext} onChange={(event) => setMinContext(Number(event.target.value))}>
        <option value={0}>beliebiger Kontext</option>
        <option value={128000}>ab 128k</option>
        <option value={200000}>ab 200k</option>
        <option value={500000}>ab 500k</option>
        <option value={1000000}>ab 1 Mio.</option>
      </select>
      <label className="mp-check">
        <input type="checkbox" checked={needsTools} onChange={(event) => setNeedsTools(event.target.checked)} />
        <span>nur mit Tool-Calling</span>
      </label>
      <b>{sichtbar.length} von {models.length}</b>
    </div>

    <div className="mp-table" role="table">
      <div className="mp-row mp-header" role="row">
        <span>{kopf('name', 'Modell')}</span>
        <span>Kosten</span>
        <span>{kopf('price', 'USD / Mio.')}</span>
        <span>{kopf('context', 'Kontext')}</span>
        <span>Fähigkeiten</span>
        <span>Zustand</span>
        <span>Freigabe</span>
      </div>
      {sichtbar.map((modell) => {
        const status = zustand(modell);
        return <div key={modell.ref} className={'mp-row' + (modell.allowed ? '' : ' forbidden')} role="row">
          <span className="mp-name">
            <strong>{modell.modelId}</strong>
            <small>
              {modell.provider}
              {modell.deprecated ? ' · abgekündigt' : ''}
              {modell.metadataSource === 'models.dev' ? ' · Angaben aus models.dev' : ''}
            </small>
          </span>
          <span className={'mp-cost ' + modell.costClass}>
            {modell.costClass === 'free' ? 'kostenlos' : modell.costClass === 'paid' ? 'kostenpflichtig' : 'unbekannt'}
          </span>
          <span className="mp-price">{preis(modell)}</span>
          <span className="mp-num">{modell.contextLength ? modell.contextLength.toLocaleString('de-DE') : '—'}</span>
          <span className="mp-caps">{modell.capabilities.length ? modell.capabilities.join(', ') : '—'}</span>
          <span className={'mp-state ' + status.klasse} title={modell.reachabilityNote ?? modell.cooldownReason ?? ''}>{status.text}</span>
          <span className="mp-allow">
            <button
              type="button"
              className={'mp-toggle' + (modell.allowed ? ' on' : '')}
              disabled={!!busy}
              title={modell.allowedSource === 'explicit'
                ? 'Ausdrückliche Entscheidung — klicken für Rücknahme auf die Standardregel'
                : modell.costClass === 'free' ? 'Kostenlos, deshalb erlaubt' : 'Braucht eine ausdrückliche Freigabe'}
              onClick={() => void fuehreAus(
                modell.allowed ? 'Sperren' : 'Freigeben',
                () => setAllowed(modell.ref, modell.allowed ? 'deny' : 'allow', 'Über die Oberfläche gesetzt'),
              )}
            ><i /></button>
            {modell.allowedSource === 'explicit'
              ? <button type="button" className="mp-reset" disabled={!!busy} title="Auf die Standardregel zurücksetzen" onClick={() => void fuehreAus('Zurücksetzen', () => setAllowed(modell.ref, 'reset'))}>↺</button>
              : <em title="Es gilt die Standardregel: kostenlos erlaubt, alles andere nicht">Regel</em>}
          </span>
        </div>;
      })}
      {!sichtbar.length && <p className="mp-empty">Kein Modell passt zu diesen Filtern.</p>}
    </div>
  </section>;
}
