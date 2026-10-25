/**
 * P22-T150 Browserabnahme: echte Bausteine (KlartextText mit Pfad-Links, NachrichtBilder, ToolBilder, BildGrossansicht) in einem
 * Fenster mit transform und eigenem Scrollbereich wie das Koordinator-Fenster. Die API-Antworten liefert die Testseite
 * (bild-vorschau-browser-p22-t150.test.mjs) aus echten Screenshots; keine Produktionsdaten.
 */
import { createRoot } from 'react-dom/client';
import { KlartextText, NachrichtBilder, VerweisFensterProvider } from '../src/components/Lesefenster';
import { ToolBilder } from '../src/components/ToolBild';
import '../src/workspace-mock.css';

const P = 'p22-t150-fixture';
const A = 'ui-screenshots/p22-t149/01-dunkel-stern-trabanten-nebel.png';
const B = 'ui-screenshots/p22-t149/07-hell-stern-trabanten-nebel.png';
const C = 'ui-screenshots/p22-t149/09-hell-commit-flug.png';
const D = 'ui-screenshots/p22-t149/10-hell-projektreaktion.png';

function Nachricht({ id, text }: { id: string; text: string }) {
  return (
    <article className="message agent text" data-fixture-nachricht={id}>
      <header>Koordinator</header>
      <KlartextText project={P} text={text} />
      <NachrichtBilder project={P} text={text} />
    </article>
  );
}

createRoot(document.getElementById('root')!).render(
  <div className="fixture-fenster" data-fixture="koordinator">
    <VerweisFensterProvider>
      <Nachricht id="1" text={'Screenshot dunkel: /home/blacky/dev/synapse/' + A + '\n\nUnd hell: `' + B + '`, der dunkle noch einmal relativ: ' + A} />
      <Nachricht id="2" text="Nicht erreichbar: ui-screenshots/gibt-es-nicht.png, dazu **asset_id: 4711**." />
      <article className="message agent text" data-fixture-nachricht="tool">
        <header>Tool-Bild (P22-T67)</header>
        <ToolBilder bilder={[{ mime_type: 'image/png', bytes: 1, project: P, file_path: C }]} />
      </article>
      <div style={{ height: 2400 }} data-fixture="abstand" />
      <Nachricht id="unten" text={'Weit unten: ' + D} />
    </VerweisFensterProvider>
  </div>,
);
