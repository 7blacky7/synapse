import React from 'react';
import {
  AusweisFehler,
  entfernePersona,
  ladePersona,
  leseBindung,
  loeseBindung,
  setzeBindung,
  weisePersonaZu,
  type IdentitaetZeile,
  type PersonaStand,
} from '../api/ausweis-verwaltung';
import { KlartextText } from './Lesefenster';

/**
 * P22-T68: Persona-Zuweisung und Task-Bindung einer Identitaet. Beides ruft die vorhandenen Routen (agent-profile/persona,
 * agent-profile/tasks/:id/bindung) mit denselben Rechten wie fuehreW1bAdminAus; der Grund kommt aus dem Grundfeld der Verwaltung.
 */
interface Props {
  project: string;
  identityId: string;
  agentId: string;
  grund: string;
  gebundeneTasks: Array<{ taskId: string; art: string }>;
  kandidaten: IdentitaetZeile[];
  onGeaendert: () => Promise<void>;
}

function fehlerText(error: unknown): string {
  return error instanceof AusweisFehler ? error.message : error instanceof Error ? error.message : String(error);
}

export function AusweisPersonaBindung({ project, identityId, agentId, grund, gebundeneTasks, kandidaten, onGeaendert }: Props) {
  const [persona, setPersona] = React.useState<PersonaStand | null>(null);
  const [vorlage, setVorlage] = React.useState('');
  const [version, setVersion] = React.useState('');
  const [userAuftrag, setUserAuftrag] = React.useState('');
  const [taskRef, setTaskRef] = React.useState('');
  const [art, setArt] = React.useState<'identitaet' | 'team'>('identitaet');
  const [teamIds, setTeamIds] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [fehler, setFehler] = React.useState('');
  const [meldung, setMeldung] = React.useState('');
  const grundOk = grund.trim().length >= 5;

  const lade = React.useCallback(async () => {
    try {
      const stand = await ladePersona(project, identityId);
      setPersona(stand);
      setVorlage((aktuell) => aktuell || stand.zuweisung?.vorlageId || stand.vorlagen[0]?.id || '');
    } catch (e) {
      setPersona(null);
      setFehler(fehlerText(e));
    }
  }, [project, identityId]);

  React.useEffect(() => {
    setPersona(null);
    setVorlage('');
    setVersion('');
    setTaskRef('');
    setFehler('');
    setMeldung('');
    void lade();
  }, [lade]);

  const ausfuehren = async (aktion: () => Promise<string>) => {
    setBusy(true);
    setFehler('');
    setMeldung('');
    try {
      setMeldung(await aktion());
      await lade();
      await onGeaendert();
    } catch (e) {
      setFehler(fehlerText(e));
    } finally {
      setBusy(false);
    }
  };

  const gewaehlt = persona?.vorlagen.find((v) => v.id === vorlage);
  const versionZahl = Number(version) || gewaehlt?.version || 0;

  const zuweisen = () => ausfuehren(async () => {
    await weisePersonaZu(project, identityId, vorlage, versionZahl, userAuftrag);
    return 'Persona "' + (gewaehlt?.name ?? vorlage) + '" v' + versionZahl + ' zugewiesen.';
  });
  const entfernen = () => ausfuehren(async () => {
    await entfernePersona(project, identityId, grund);
    return 'Persona entfernt.';
  });

  const binden = () => ausfuehren(async () => {
    const ref = taskRef.trim();
    const ids = art === 'team' ? [...new Set([identityId, ...teamIds])] : [identityId];
    const stand = await leseBindung(project, ref);
    await setzeBindung(project, ref, art, ids, grund, stand.art !== 'offen');
    setTaskRef('');
    return 'Task ' + ref + (stand.art !== 'offen' ? ' neu gebunden (vorherige Bindung ersetzt)' : ' gebunden') + (art === 'team' ? ' an Team (' + ids.length + ' Identitaeten).' : ' an ' + agentId + '.');
  });

  const loesen = (taskId: string) => ausfuehren(async () => {
    const stand = await leseBindung(project, taskId);
    const rest = stand.identityIds.filter((id) => id !== identityId);
    if (stand.art === 'team' && rest.length > 0) {
      await setzeBindung(project, taskId, rest.length === 1 ? 'identitaet' : 'team', rest, grund, true);
      return 'Identitaet aus dem Team der Task ' + taskId + ' geloest (' + rest.length + ' bleiben gebunden).';
    }
    await loeseBindung(project, taskId, grund);
    return 'Bindung der Task ' + taskId + ' geloest (Task ist wieder offen).';
  });

  return <div className="av-zusatz">
    <h5>Persona</h5>
    {!persona && !fehler && <p className="av-leer">Persona wird geladen …</p>}
    {persona && <>
      <p className="av-leer">{persona.zuweisung ? 'Zugewiesen: ' + (persona.vorlagen.find((v) => v.id === persona.zuweisung?.vorlageId)?.name ?? persona.zuweisung.vorlageId) + ' v' + persona.zuweisung.version + ' (gesetzt von ' + persona.zuweisung.gesetztVon + ', ' + persona.zuweisung.gesetztAm + ')' : 'Keine Persona zugewiesen. Eine Persona gilt nur auf ausdruecklichen User-Wunsch.'}</p>
      <div className="av-formular">
        <label>Vorlage<select value={vorlage} onChange={(e) => { setVorlage(e.target.value); setVersion(''); }}>{persona.vorlagen.map((v) => <option key={v.id} value={v.id}>{v.name + ' (' + v.scope + ', aktuell v' + v.version + (v.status === 'archiviert' ? ', archiviert' : '') + ')'}</option>)}</select></label>
        <label>Version<input value={version} inputMode="numeric" placeholder={gewaehlt ? 'aktuell v' + gewaehlt.version : ''} onChange={(e) => setVersion(e.target.value)} /></label>
        <label>User-Auftrag (Wortlaut)<input value={userAuftrag} onChange={(e) => setUserAuftrag(e.target.value)} placeholder="nur noetig, wenn nicht als User angemeldet" /></label>
      </div>
      <div className="av-aktionen">
        <button type="button" disabled={busy || !vorlage || !versionZahl} onClick={() => void zuweisen()}>Persona zuweisen</button>
        <button type="button" disabled={busy || !grundOk || !persona.zuweisung} onClick={() => void entfernen()}>Persona entfernen</button>
      </div>
      {!persona.vorlagen.length && <p className="av-leer">Keine Persona-Vorlagen angelegt (Anlegen: admin persona_anlegen).</p>}
    </>}

    <h5>Task-Bindung ({gebundeneTasks.length})</h5>
    {gebundeneTasks.length === 0 && <p className="av-leer">Keine Task ist an diese Identitaet gebunden.</p>}
    {gebundeneTasks.map((t) => <div className="av-regelzeile" key={t.taskId}>
      <span className="av-bindung-task"><KlartextText project={project} text={t.taskId} /> <small>({t.art})</small></span>
      <button type="button" disabled={busy || !grundOk} onClick={() => void loesen(t.taskId)}>Loesen</button>
    </div>)}
    <div className="av-formular">
      <label>Task (Kurz-ID oder UUID)<input value={taskRef} onChange={(e) => setTaskRef(e.target.value)} placeholder="z. B. P22-T68" /></label>
      <label>Art<select value={art} onChange={(e) => setArt(e.target.value as 'identitaet' | 'team')}><option value="identitaet">nur diese Identitaet</option><option value="team">Team mit weiteren Identitaeten</option></select></label>
    </div>
    {art === 'team' && <div className="av-checks">{kandidaten.filter((k) => k.identityId !== identityId && k.status === 'aktiv').map((k) => <label key={k.identityId}><input type="checkbox" checked={teamIds.includes(k.identityId)} onChange={() => setTeamIds((ids) => (ids.includes(k.identityId) ? ids.filter((x) => x !== k.identityId) : [...ids, k.identityId]))} />{k.agentId}</label>)}</div>}
    <div className="av-aktionen"><button type="button" disabled={busy || !grundOk || !taskRef.trim()} onClick={() => void binden()}>Task binden</button></div>
    {!grundOk && <p className="av-leer">Zum Binden und Loesen oben einen Grund eintragen.</p>}
    {fehler && <p className="av-fehler" role="alert">{fehler}</p>}
    {meldung && <p className="av-meldung">{meldung}</p>}
  </div>;
}
