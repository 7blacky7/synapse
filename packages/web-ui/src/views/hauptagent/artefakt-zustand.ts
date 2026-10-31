import type { AgentArtifactEvent } from '../../api/agent-runtime';
import type { AgentHtmlBlock, AgentMessage } from '../../components/gemeinsam/agent-nachrichten-typen';

function istNeuereRevision(neu: AgentHtmlBlock['revision'], alt: AgentHtmlBlock['revision']): boolean {
  if (neu === undefined || alt === undefined) return true;
  const a = Number(neu);
  const b = Number(alt);
  return Number.isFinite(a) && Number.isFinite(b) ? a >= b : true;
}

// P8-T25: Ein Artefakt mit bekannter id ersetzt seinen Block (auch in einer
// früheren Antwort), statt einen zweiten anzuhängen; maßgeblich ist die revision.
// Pflicht sind nur id und html, alles andere bekommt eine Vorgabe.
export function setzeArtefaktBlock(
  items: AgentMessage[],
  block: AgentArtifactEvent,
  ziel: { artefaktId: number; nummer: number; titel: string; auftrag: string },
): AgentMessage[] {
  const id = block.id || 'block-' + ziel.nummer;
  const baue = (alt?: AgentHtmlBlock): AgentHtmlBlock => ({
    id,
    html: block.html,
    column: block.column ?? alt?.column ?? 1,
    columnSpan: block.columnSpan ?? alt?.columnSpan ?? 12,
    row: block.row ?? alt?.row ?? ziel.nummer,
    rowSpan: block.rowSpan ?? alt?.rowSpan ?? 1,
    minHeight: block.minHeight ?? alt?.minHeight ?? 220,
    ...(block.revision === undefined ? {} : { revision: block.revision }),
    ...(block.interactive === undefined ? {} : { interactive: block.interactive }),
  });
  const vorhanden = items.find((message) => message.kind === 'artifact' && message.blocks?.some((item) => item.id === id));
  if (vorhanden) {
    return items.map((message) => message.id !== vorhanden.id ? message : {
      ...message,
      title: block.title || message.title,
      blocks: (message.blocks || []).map((item) => item.id === id && istNeuereRevision(block.revision, item.revision) ? baue(item) : item),
    });
  }
  if (items.some((message) => message.id === ziel.artefaktId)) {
    return items.map((message) => message.id === ziel.artefaktId ? { ...message, title: ziel.titel, blocks: [...(message.blocks || []), baue()] } : message);
  }
  return [...items, { id: ziel.artefaktId, role: 'agent', kind: 'artifact', title: ziel.titel, text: ziel.auftrag, blocks: [baue()], layout: { columns: 12, rowHeight: 72, gap: 12 }, saved: false }];
}
