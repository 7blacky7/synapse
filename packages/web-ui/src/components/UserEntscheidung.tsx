import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { leseChatZitateStand } from '../api/chat-zitate';
import { leseUserEntscheidungen, pinneUserEntscheidung, type UserEntscheidungEintrag } from '../api/user-entscheidung';
import { ART_LABEL, type VerweisArt } from '../api/verweise';
import type { PinEingabe } from './zitat-logik';
import type { PinEmpfaenger } from './ZitatEmpfaenger';
import '../chat-zitate.css';

/**
 * P22-T168 Punkte 8/9 (Nachtrag eef3b1f7, Vorgabe 05aebb72): 'User-Entscheidung anpinnen' im zentralen Lesefenster einer Task bzw.
 * eines Plans - ueberall gleich, auch wenn das Fenster aus einem Artefakt geoeffnet wurde (die Artefakttafel selbst bleibt
 * unveraendert). Kein Chat noetig: Speichern legt SOFORT einen thought als User an (Tag user-entscheidung, task_id bzw. Plan-Tag);
 * der Server gibt dem Bearbeiter der Task einen kurzen Inbox-Hinweis. Darunter die angepinnten User-Entscheidungen.
 * useUserEntscheidung -> knopf (Kopf des Lesefensters) und bereich (Editor, Meldung, Liste). anpinnen = Zaehler aus dem
 * Kontextmenue eines Chat-Verweises: jede Erhoehung oeffnet den Editor.
 * P22-T171 Punkt 4 (User 83b5014f): fuer JEDE Verweis-Art, die das Lesefenster oeffnet (Server: Tag '<art>:<id>', task_id nur bei
 * Tasks). Punkt 1: ohne Chat-/Channel-Herkunft zeigt der Editor OPTIONAL die Empfaengerauswahl (Prop empfaenger, ZitatEmpfaenger.tsx
 * usePinEmpfaenger); ohne Auswahl nur speichern, mit Auswahl danach der Pin als Block an jeden Gewaehlten.
 * SCHALTER chat_zitate (api/chat-zitate.ts, Projekt des Verweises; AUS = kein Knopf, keine Liste). DEBUG: data-user-entscheidung,
 * data-user-entscheidung-art, console.debug('[user-entscheidung]', ...).
 */
export type UserEntscheidungArt = VerweisArt;
const PIN_ARTEN: readonly string[] = ['task', 'plan', 'thought', 'memory', 'doc', 'event', 'nachricht', 'chat', 'asset', 'artefakt'];
export const kannAnpinnen = (art: string): art is UserEntscheidungArt => PIN_ARTEN.includes(art);

const MAX_STANDARD = 2000;
interface Editor { text: string; hinweis: string; laeuft: boolean }
const LEER: Editor = { text: '', hinweis: '', laeuft: false };

function zeitLokal(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('de-DE');
}

export function useUserEntscheidung({ project, art, id, anzeigeId, titel, anpinnen = 0, nachAnpinnen, empfaenger }: {
  project: string; art: VerweisArt; id: string; anzeigeId?: string; titel?: string; anpinnen?: number;
  /** P22-T170: Lesefenster mit Chat-/Channel-Herkunft - Pin zusaetzlich als Kaertchen in dessen Entwurf; Rueckgabe = Zusatz der Meldung. */
  nachAnpinnen?: (pin: PinEingabe) => string | null;
  /** P22-T171 Punkt 1: Lesefenster OHNE Herkunft - optionale Empfaengerauswahl im Editor. */
  empfaenger?: PinEmpfaenger;
}): { aktiv: boolean; knopf: ReactNode; bereich: ReactNode } {
  const moeglich = kannAnpinnen(art) && !!id;
  const [aktiv, setAktiv] = useState(false);
  const [max, setMax] = useState(MAX_STANDARD);
  const [eintraege, setEintraege] = useState<UserEntscheidungEintrag[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [meldung, setMeldung] = useState('');
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let lebt = true;
    setAktiv(false); setEintraege([]); setEditor(null); setMeldung('');
    if (!kannAnpinnen(art) || !id) return () => { lebt = false; };
    void leseChatZitateStand(project).then(async (stand) => {
      if (!lebt) return;
      setAktiv(stand.aktiv);
      if (stand.grenzen?.anmerkung_max) setMax(stand.grenzen.anmerkung_max);
      if (!stand.aktiv) return;
      const liste = await leseUserEntscheidungen(project, art, id);
      if (lebt) setEintraege(liste.eintraege);
      if (liste.fehler) console.debug('[user-entscheidung]', 'liste', { project, art, id, fehler: liste.fehler });
    });
    return () => { lebt = false; };
  }, [project, art, id]);

  // Kontextmenue 'User-Entscheidung anpinnen' an einem Chat-Verweis: Editor oeffnen (auch bei schon offenem Fenster).
  useEffect(() => { if (anpinnen > 0 && aktiv) setEditor((e) => e ?? LEER); }, [anpinnen, aktiv]);
  const offen = !!editor;
  useEffect(() => { if (offen) textRef.current?.focus(); }, [offen]);

  if (!moeglich || !aktiv) return { aktiv: false, knopf: null, bereich: null };
  const zielArt = art as UserEntscheidungArt;
  const kopf = ART_LABEL[art] + ' ' + (anzeigeId || id);

  const speichern = async () => {
    if (!editor || editor.laeuft) return;
    const text = editor.text.trim();
    if (!text) { setEditor({ ...editor, hinweis: 'Bitte die Entscheidung eintragen.' }); return; }
    if (text.length > max) { setEditor({ ...editor, hinweis: 'Höchstens ' + max + ' Zeichen.' }); return; }
    setEditor({ ...editor, laeuft: true, hinweis: '' });
    const r = await pinneUserEntscheidung({ project, art: zielArt, id, text, ...(titel ? { titel } : {}) });
    console.debug('[user-entscheidung]', 'anpinnen', { project, art, id, ergebnis: r });
    if (!r.ok) { setEditor((e) => e && { ...e, laeuft: false, hinweis: r.message }); return; }
    const pin: PinEingabe = { thoughtId: r.thought_id, projekt: project, kopf, ...(titel ? { titel } : {}), text };
    // P22-T171 Punkt 1: erst speichern (oben), dann optional an die Gewaehlten; ein Fehler beim Senden macht den Pin nicht rueckgaengig.
    const gesendet = empfaenger?.anzahl ? await empfaenger.senden(pin) : '';
    if (empfaenger?.anzahl) console.debug('[user-entscheidung]', 'an_empfaenger', { project, art, id, thought: r.thought_id, meldung: gesendet });
    setEditor(null);
    const zusatz = nachAnpinnen?.(pin) ?? null;
    setMeldung('Angepinnt an ' + kopf + '.' + (r.empfaenger.length ? ' Hinweis an ' + r.empfaenger.join(', ') + '.' : '') + (zusatz ? ' ' + zusatz : '') + (gesendet ? ' ' + gesendet : ''));
    const liste = await leseUserEntscheidungen(project, zielArt, id);
    setEintraege(liste.eintraege);
  };
  const beiTaste = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); schliessen(); }
    else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void speichern(); }
  };
  const schliessen = () => { setEditor(null); empfaenger?.zuruecksetzen(); };

  const knopf = (
    <button type="button" className="verweis-entscheidung" title={'Entscheidung als User an ' + kopf + ' anpinnen' + (nachAnpinnen ? ' (zusätzlich als Kärtchen in den Entwurf dieses Chats)'
      : empfaenger ? ' (speichern; optional an gewählte Agenten senden)' : ' (nur speichern)')}
      onClick={() => { setMeldung(''); setEditor((e) => e ?? LEER); }}>User-Entscheidung anpinnen</button>
  );
  const bereich = (
    <section className="user-entscheidungen" data-user-entscheidung={eintraege.length} data-user-entscheidung-art={art}>
      {editor && (
        <div className="user-entscheidung-editor" role="group" aria-label={'User-Entscheidung an ' + kopf} data-user-entscheidung-editor="">
          <header>
            <small>User-Entscheidung an</small>
            <strong>{kopf}</strong>
            {titel && <span>{titel}</span>}
          </header>
          <textarea ref={textRef} rows={4} value={editor.text} placeholder="Deine Entscheidung im Wortlaut …" disabled={editor.laeuft}
            onChange={(event) => setEditor({ ...editor, text: event.target.value, hinweis: '' })} onKeyDown={beiTaste} />
          {empfaenger?.feld && (
            <div className="user-entscheidung-empfaenger" data-pin-empfaenger={empfaenger.anzahl}>
              <small>Optional an Agenten senden (ohne Auswahl nur speichern)</small>
              {empfaenger.feld}
            </div>
          )}
          <footer>
            <span className={editor.hinweis ? 'zitat-hinweis' : ''}>{editor.hinweis || (editor.laeuft ? 'Wird angepinnt …' : editor.text.trim().length + ' / ' + max + ' · Strg+Enter speichert')}</span>
            <button type="button" onClick={schliessen}>Abbrechen</button>
            <button type="button" className="zitat-speichern" disabled={editor.laeuft} onClick={() => { void speichern(); }}>{empfaenger?.anzahl ? 'Speichern und senden' : 'Speichern'}</button>
          </footer>
        </div>
      )}
      {meldung && <p className="user-entscheidung-meldung" role="status">{meldung}</p>}
      {eintraege.length > 0 && (
        <>
          <h4>User-Entscheidungen ({eintraege.length})</h4>
          <ol>
            {eintraege.map((e) => (
              <li key={e.id} data-thought={e.id}>
                <header><b>{e.source}</b> <small>{zeitLokal(e.timestamp)}</small> <small>{e.id.slice(0, 8)}</small></header>
                <p>{e.content}</p>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
  return { aktiv: true, knopf, bereich };
}
