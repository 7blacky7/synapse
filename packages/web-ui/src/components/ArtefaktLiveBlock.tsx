import { useEffect, useState } from 'react';
import AgentRenderingSurface from '../kios/AgentRenderingSurface';
import SkriptRahmen from '../kios/SkriptRahmen';
import { abonniereArtefaktLive, zeichneArtefaktNeu } from '../api/agent-runtime';

/**
 * P22-T154: ein Artefakt-Block mit Vorlage (Koordinator-Fenster, Persoenliche Artefakte). Fertiges HTML (ohne Vorlage) wird
 * unveraendert gezeigt. Mit Vorlage: Kopfzeile mit Projekt, Stand-Zeit, Knopf 'Neu zeichnen' (Server rendert mit aktuellen Daten);
 * modus live: Live-Strom (nur bei Schalter artefakt_vorlagen_live EIN, sonst meldet der Server 'aus' und der Block bleibt Stand).
 * Volle Breite, kein Raster (R7). Das HTML bereinigt AgentRenderingSurface (sanitize.ts) wie jeden Agenten-Block.
 * P22-T169: die Auswahl des Betrachters (Radio/Checkbox/details) bleibt je Artefakt-ID auch ueber das Neuladen erhalten.
 */
export interface ArtefaktLiveBlockProps {
  id: string;
  html: string;
  revision?: string | number;
  modus?: string;
  project?: string | null;
  vorlage?: boolean;
  gerendertAm?: string;
  className?: string;
  /** P22-T165: Projekt fuer Verweise, wenn das Artefakt kein Render-Projekt hat (Projekt des Anzeigeorts). */
  verweisProjekt?: string | null;
  /** P22-T166: Skript ausfuehren (nur Top-Artefakte, Schalter artefakt_skripte): Darstellung im abgeschotteten Skript-Rahmen. */
  skript?: { titel?: string | null } | null;
  /** Neue Renderung (Neu zeichnen, live) nach aussen melden, z. B. fuer die Liste. */
  onNeu?: (d: { html: string; revision: number; project: string | null; gerendert_am: string }) => void;
}

function zeitText(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function ArtefaktLiveBlock({ id, html, revision, modus, project, vorlage, gerendertAm, className, onNeu, verweisProjekt, skript }: ArtefaktLiveBlockProps) {
  const [stand, setStand] = useState({ html, revision: String(revision ?? ''), gerendertAm: gerendertAm ?? '' });
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState('');
  const [live, setLive] = useState<'aus' | 'bereit' | 'fehler' | 'verbindet'>('verbindet');

  useEffect(() => { setStand({ html, revision: String(revision ?? ''), gerendertAm: gerendertAm ?? '' }); }, [id, html, revision, gerendertAm]);

  useEffect(() => {
    if (!vorlage || modus !== 'live') return undefined;
    setLive('verbindet');
    return abonniereArtefaktLive(id, project ?? null, (d) => {
      setStand({ html: d.html, revision: String(d.revision), gerendertAm: d.gerendert_am });
      onNeu?.({ html: d.html, revision: d.revision, project: d.project, gerendert_am: d.gerendert_am });
    }, (s) => setLive(s.art));
  }, [id, project, vorlage, modus]);

  const neuZeichnen = async () => {
    setBusy(true);
    setFehler('');
    try {
      const r = await zeichneArtefaktNeu(id, project ?? null);
      setStand({ html: r.html, revision: String(r.render.revision), gerendertAm: r.render.gerendert_am });
      onNeu?.({ html: r.html, revision: r.render.revision, project: r.render.project, gerendert_am: r.render.gerendert_am });
    } catch (error) {
      setFehler(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return <div className="artefakt-live-block" data-artefakt={id} data-modus={modus ?? 'fest'} data-live={vorlage && modus === 'live' ? live : 'aus'}>
    {vorlage && <div className="artefakt-live-kopf" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', font: '600 10px "IBM Plex Mono", monospace', opacity: 0.85, margin: '2px 0 4px' }}>
      <span>{modus === 'live' ? (live === 'bereit' ? '● live' : live === 'verbindet' ? '○ live verbindet …' : '○ Stand (live aus)') : 'Stand'}</span>
      {project && <span>· {project}</span>}
      {stand.gerendertAm && <span>· {zeitText(stand.gerendertAm)}</span>}
      <button type="button" onClick={() => void neuZeichnen()} disabled={busy} style={{ marginLeft: 'auto' }}>{busy ? 'zeichnet …' : 'Neu zeichnen'}</button>
      {fehler && <small style={{ flexBasis: '100%', color: 'var(--danger, #b00)' }}>{fehler}</small>}
    </div>}
    {/* P22-T166: Skript-Artefakt in den Top-Artefakten -> Skript-Rahmen (neuer Stand geht als Ereignis an das Skript, kein Neuladen). */}
    {skript ? <SkriptRahmen artefaktId={id} html={stand.html} revision={stand.revision} projekt={project || verweisProjekt || null} titel={skript.titel ?? null}
      className={className} />
    /* P22-T165: Vorlagen-Updates ohne Aufbau-Animation (nur beim ersten Anzeigen), Verweise mit dem Render-Projekt. */
    : <AgentRenderingSurface html={stand.html} revision={id + ':' + stand.revision} className={className ?? 'native-html-block agent-chat-html'}
      verweisProjekt={project || verweisProjekt || null} updateOhneAnimation={!!vorlage} zustandSchluessel={'artefakt:' + id} />}
  </div>;
}

export default ArtefaktLiveBlock;
