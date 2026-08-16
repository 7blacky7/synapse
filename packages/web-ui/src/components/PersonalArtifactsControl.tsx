import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { PersonalArtifact, PersonalArtifactStatus, PersonalMemory } from '../mock/personal-knowledge';
import './personal-artifacts-control.css';

type StatusFilter = 'Alle' | 'Neu' | 'Nicht analysiert' | 'Verarbeitet' | 'Mit Memories verknüpft' | 'Archiviert';
type DeleteMode = 'file' | 'file-and-memories';

interface Props {
  artifacts: PersonalArtifact[];
  setArtifacts: Dispatch<SetStateAction<PersonalArtifact[]>>;
  memories: PersonalMemory[];
  setMemories: Dispatch<SetStateAction<PersonalMemory[]>>;
}

const filters: StatusFilter[] = ['Alle', 'Neu', 'Nicht analysiert', 'Verarbeitet', 'Mit Memories verknüpft', 'Archiviert'];

function matchesFilter(artifact: PersonalArtifact, filter: StatusFilter) {
  if (filter === 'Alle') return true;
  if (filter === 'Mit Memories verknüpft') return artifact.linkedMemoryIds.length > 0;
  if (filter === 'Nicht analysiert') return ['Neu', 'Wartet auf Nachtanalyse'].includes(artifact.status);
  return artifact.status === filter;
}

function statusTone(status: PersonalArtifactStatus) {
  if (status === 'Verarbeitet' || status === 'Bereit') return 'done';
  if (status === 'Wird analysiert') return 'working';
  if (status === 'Archiviert') return 'archived';
  return 'pending';
}

function fileGlyph(kind: string) {
  if (kind.includes('Bild')) return '▧';
  if (kind.includes('E-Mail')) return '✉';
  if (kind === 'PDF') return 'PDF';
  return 'TXT';
}

function DeleteDialog({
  artifact,
  mode,
  setMode,
  onCancel,
  onConfirm,
}: {
  artifact: PersonalArtifact;
  mode: DeleteMode;
  setMode: (mode: DeleteMode) => void;
  onCancel: () => void;
  onConfirm: (mode: DeleteMode) => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [phrase, setPhrase] = useState('');
  const destructive = mode === 'file-and-memories';
  const allowed = destructive ? confirmed && phrase === 'LÖSCHEN' : confirmed;

  return <div className="artifact-delete-backdrop" role="presentation">
    <section className="artifact-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="artifact-delete-title">
      <header>
        <div><span>GETRENNTER LÖSCHVORGANG · MOCK</span><h3 id="artifact-delete-title">{artifact.title}</h3></div>
        <button type="button" onClick={onCancel}>×</button>
      </header>
      <div className="artifact-delete-options">
        <button type="button" className={mode === 'file' ? 'active' : ''} onClick={() => { setMode('file'); setConfirmed(false); setPhrase(''); }}>
          <strong>Nur Datei löschen</strong>
          <span>Das Original verschwindet. {artifact.linkedMemoryIds.length} vorhandene Memories bleiben bestehen.</span>
        </button>
        <button type="button" className={destructive ? 'active danger' : ''} onClick={() => { setMode('file-and-memories'); setConfirmed(false); setPhrase(''); }}>
          <strong>Datei + abgeleitete Memories löschen</strong>
          <span>Separater Vorgang: Original und {artifact.linkedMemoryIds.length} verknüpfte Memories werden entfernt.</span>
        </button>
      </div>
      <label className="artifact-delete-check">
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>{destructive ? 'Ich bestätige, dass Datei und abgeleitete Memories entfernt werden.' : 'Ich bestätige, dass nur die Originaldatei entfernt wird.'}</span>
      </label>
      {destructive && <label className="artifact-delete-phrase"><span>Zur deutlichen Bestätigung „LÖSCHEN“ eingeben</span><input value={phrase} onChange={(event) => setPhrase(event.target.value)} /></label>}
      <footer>
        <button type="button" onClick={onCancel}>Abbrechen</button>
        <button type="button" className="danger" disabled={!allowed} onClick={() => onConfirm(mode)}>{destructive ? 'Datei + Memories löschen' : 'Nur Datei löschen'}</button>
      </footer>
    </section>
  </div>;
}

export function PersonalArtifactsControl({ artifacts, setArtifacts, memories, setMemories }: Props) {
  const [selectedId, setSelectedId] = useState(artifacts[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('Alle');
  const [viewerOpen, setViewerOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteMode, setDeleteMode] = useState<DeleteMode>('file');
  const [notice, setNotice] = useState('');

  const visible = useMemo(() => artifacts.filter((artifact) => {
    const haystack = [artifact.title, artifact.kind, artifact.origin, artifact.status, artifact.tags.join(' ')].join(' ').toLowerCase();
    return matchesFilter(artifact, filter) && haystack.includes(query.trim().toLowerCase());
  }), [artifacts, filter, query]);

  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? visible[0];
  const linkedMemories = selected ? memories.filter((memory) => selected.linkedMemoryIds.includes(memory.id)) : [];

  const selectArtifact = (id: string) => {
    setSelectedId(id);
    setViewerOpen(false);
    setDeleteOpen(false);
    setNotice('');
  };

  const archive = () => {
    if (!selected) return;
    const next: PersonalArtifactStatus = selected.status === 'Archiviert' ? 'Verarbeitet' : 'Archiviert';
    setArtifacts((current) => current.map((artifact) => artifact.id === selected.id ? { ...artifact, status: next } : artifact));
    setNotice(next === 'Archiviert' ? 'Artefakt im UI-Mock archiviert.' : 'Artefakt aus dem UI-Mock-Archiv zurückgeholt.');
  };

  const remove = (mode: DeleteMode) => {
    if (!selected) return;
    if (mode === 'file-and-memories') {
      const linkedIds = new Set(selected.linkedMemoryIds);
      setMemories((current) => current.filter((memory) => !linkedIds.has(memory.id)));
    }
    setArtifacts((current) => current.filter((artifact) => artifact.id !== selected.id));
    setDeleteOpen(false);
    setSelectedId('');
    setNotice(mode === 'file' ? 'Nur die Datei wurde im Mock entfernt. Memories bleiben bestehen.' : 'Datei und abgeleitete Memories wurden im Mock getrennt entfernt.');
  };

  return <div className="personal-artifact-control">
    <header className="artifact-control-header">
      <div>
        <span>PRIVATES MAIN-AGENT-VOLUME · UI1–UI3 MOCK</span>
        <h2>Persönliche Artefakte</h2>
        <p>Kontrolle der Dateien, die später ausschließlich über den Hauptagenten-Chat eingehen.</p>
      </div>
      <div className="artifact-ingest-flow" aria-label="Späterer Eingangsweg">
        <b>CHAT</b><i>→</i><b>SYNAPSE API</b><i>→</i><b>PRIVATES VOLUME</b><i>→</i><b>MAIN-AGENT</b>
      </div>
    </header>

    <section className="artifact-privacy-strip">
      <strong>Original privat</strong>
      <span>Projektkoordinatoren und Spezialisten sehen weder Originaldatei noch Serverpfad. Nur gezielt freigegebene Ableitungen dürfen später in ein Projekt gelangen.</span>
      <em>Kein Upload in dieser Ansicht</em>
    </section>

    <div className="artifact-control-tools">
      <label><span>Suche</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Dateiname, Typ, Herkunft oder Tag …" /></label>
      <label><span>Statusfilter</span><select value={filter} onChange={(event) => setFilter(event.target.value as StatusFilter)}>{filters.map((item) => <option key={item}>{item}</option>)}</select></label>
      <div className="artifact-filter-shortcuts">{filters.map((item) => <button type="button" key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item}</button>)}</div>
    </div>

    <section className="artifact-control-body">
      <aside className="artifact-file-list">
        <header><span>{visible.length} von {artifacts.length} Dateien</span><small>global · projektunabhängig</small></header>
        <div className="artifact-list-columns"><span>Datei</span><span>Eingang</span><span>Status</span><span>Mem.</span></div>
        <div className="artifact-list-scroll">
          {visible.map((artifact) => <button type="button" key={artifact.id} className={selected?.id === artifact.id ? 'active' : ''} onClick={() => selectArtifact(artifact.id)}>
            <i>{fileGlyph(artifact.kind)}</i>
            <span className="artifact-file-name"><strong>{artifact.title}</strong><small>{artifact.kind} · {artifact.size ?? 'Größe unbekannt'} · {artifact.origin}</small></span>
            <time>{artifact.addedAt}</time>
            <em className={'artifact-status ' + statusTone(artifact.status)}>{artifact.status}</em>
            <b>{artifact.linkedMemoryIds.length}</b>
          </button>)}
          {!visible.length && <p className="artifact-empty">Keine persönlichen Artefakte für Suche und Statusfilter.</p>}
        </div>
      </aside>

      <main className="artifact-control-detail">
        {selected ? <>
          <header className="artifact-detail-title">
            <div><span>{selected.kind} · {selected.category}</span><h3>{selected.title}</h3><p>Artifact-ID: <code>{selected.id}</code></p></div>
            <em className={'artifact-status ' + statusTone(selected.status)}>{selected.status}</em>
          </header>

          <section className="artifact-preview-control">
            <header><b>VORSCHAU</b><span>Mock · Original verbleibt im privaten Speicher</span></header>
            {selected.kind.includes('Bild')
              ? <div className="artifact-image-preview"><i>▧</i><strong>Geschützte Bildvorschau</strong><small>{selected.preview}</small></div>
              : <p>{selected.preview}</p>}
          </section>

          <div className="artifact-actionbar">
            <button type="button" onClick={() => setViewerOpen(true)}>Ansehen</button>
            <button type="button" onClick={() => setNotice('Download wurde ausschließlich als UI-Mock simuliert.')}>Herunterladen <small>MOCK</small></button>
            <button type="button" onClick={archive}>{selected.status === 'Archiviert' ? 'Zurückholen' : 'Archivieren'}</button>
            <button type="button" className="danger" onClick={() => { setDeleteMode('file'); setDeleteOpen(true); }}>Löschen</button>
          </div>
          {notice && <p className="artifact-notice">{notice}</p>}

          <dl className="artifact-technical-data">
            <div><dt>Dateiname</dt><dd>{selected.title}</dd></div>
            <div><dt>Typ / Größe</dt><dd>{selected.kind} · {selected.size ?? 'unbekannt'}</dd></div>
            <div><dt>Artifact-ID</dt><dd><code>{selected.id}</code></dd></div>
            <div className="wide"><dt>Serverpfad</dt><dd><code>{selected.serverPath ?? 'wird später von Synapse API geliefert'}</code></dd></div>
            <div><dt>Herkunft</dt><dd>{selected.origin}</dd></div>
            <div><dt>Eingang</dt><dd>{selected.addedAt}</dd></div>
            <div><dt>Letzter Zugriff</dt><dd>{selected.lastAccessedAt ?? 'noch nie'}</dd></div>
            <div><dt>Letzte Analyse</dt><dd>{selected.lastAnalyzedAt ?? 'noch nicht analysiert'}</dd></div>
            <div><dt>Verarbeitung</dt><dd>{selected.status}</dd></div>
            <div><dt>Memory-Verknüpfungen</dt><dd>{selected.linkedMemoryIds.length}</dd></div>
          </dl>

          <section className="artifact-insight-grid">
            <article>
              <header><b>ERKANNTE / ABGELEITETE INFORMATIONEN</b><span>{selected.derivedInformation?.length ?? 0}</span></header>
              {selected.derivedInformation?.length
                ? <ul>{selected.derivedInformation.map((item) => <li key={item}>{item}</li>)}</ul>
                : <p>Noch keine Ableitungen. {selected.status === 'Wartet auf Nachtanalyse' ? 'Für den Nachtlauf vorgemerkt.' : 'Analyse steht aus.'}</p>}
            </article>
            <article>
              <header><b>VERKNÜPFTE MEMORIES</b><span>{linkedMemories.length}</span></header>
              {linkedMemories.length
                ? linkedMemories.map((memory) => <div className="artifact-memory-link" key={memory.id}><strong>{memory.title}</strong><small>{memory.category} · USER MEMORY</small></div>)
                : <p>Keine Memories verknüpft. Das Artefakt wird nicht automatisch zu einem Memory.</p>}
            </article>
          </section>

          <section className="artifact-usage-history">
            <header><b>NUTZUNGSHISTORIE</b><span>Mock-Verlauf</span></header>
            {(selected.usageHistory ?? []).map((entry) => <div key={entry.id}><time>{entry.at}</time><strong>{entry.actor}</strong><span>{entry.action}</span><em>{entry.result}</em></div>)}
          </section>
        </> : <div className="artifact-empty">Datei auswählen. Persönliche Originalartefakte bleiben projektunabhängig.</div>}
      </main>
    </section>

    {viewerOpen && selected && <div className="artifact-viewer-backdrop" role="presentation" onMouseDown={() => setViewerOpen(false)}>
      <section className="artifact-viewer" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><span>GESCHÜTZTE VORSCHAU · MOCK</span><h3>{selected.title}</h3></div><button type="button" onClick={() => setViewerOpen(false)}>×</button></header>
        <div>{selected.kind.includes('Bild') ? <div className="artifact-image-preview large"><i>▧</i><strong>Bildinhalt wird später kontrolliert geladen</strong><small>{selected.serverPath}</small></div> : <pre>{selected.preview}</pre>}</div>
        <footer><code>{selected.id}</code><span>Nur Benutzer + Main-Agent</span></footer>
      </section>
    </div>}

    {deleteOpen && selected && <DeleteDialog artifact={selected} mode={deleteMode} setMode={setDeleteMode} onCancel={() => setDeleteOpen(false)} onConfirm={remove} />}
  </div>;
}
