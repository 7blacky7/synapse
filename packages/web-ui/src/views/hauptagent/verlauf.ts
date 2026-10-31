import { anzeigeAusAnhaengen } from '../../components/zitat-logik';
import type { MainAgentVerlaufEintrag } from '../../api/agent-runtime';
import type { ToolCallViewModel } from '../../control-plane/view-model';
import { verlaufInfo, verlaufWerkzeuge, verlaufZugInfo } from '../../components/agent-chat-logik';
import type { AgentMessage } from '../../components/gemeinsam/agent-nachrichten-typen';
import { setzeArtefaktBlock } from './artefakt-zustand';
import { WARTE_GRUND } from './hauptagent-konstanten';

// P22-T63: Anzeige-IDs aus den Server-IDs des Verlaufs (Text 2n, Artefakt der Antwort 2n+1), damit Verlauf und eigener
// Strom dieselbe Nachricht treffen. Lokale Nachrichten ohne Server-ID behalten Date.now()-IDs (groesser, also hinten).
export const verlaufAnzeigeId = (serverId: string, artefakt = false): number => Number(serverId) * 2 + (artefakt ? 1 : 0);

// P22-T67: Bilder des dauerhaften Wegs: Sitzungs-Eintraege (jsonl:) tragen den Asset-Verweis in meta.bilder. Sie erscheinen als
// Bild-Aufruf in der Werkzeugliste der zugehoerigen (sonst der letzten) Agent-Antwort, ueber dieselbe Komponente wie der Altweg.
function verlaufMetaBilder(eintrag: MainAgentVerlaufEintrag): NonNullable<ToolCallViewModel['bilder']> {
  const roh = eintrag.meta?.bilder;
  if (!Array.isArray(roh)) return [];
  return roh.filter((b): b is NonNullable<ToolCallViewModel['bilder']>[number] => !!b && typeof b === 'object' && typeof (b as { mime_type?: unknown }).mime_type === 'string');
}

function haengeMetaBilderAn(items: AgentMessage[], eintrag: MainAgentVerlaufEintrag): AgentMessage[] {
  const bilder = verlaufMetaBilder(eintrag);
  if (!bilder.length) return items;
  const zielId = eintrag.gehoert_zu ? verlaufAnzeigeId(eintrag.gehoert_zu) : null;
  let ziel = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].role === 'agent' && items[i].kind === 'text' && (zielId === null || items[i].id === zielId)) { ziel = i; break; }
  }
  if (ziel < 0 && zielId !== null) {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].role === 'agent' && items[i].kind === 'text') { ziel = i; break; }
  }
  if (ziel < 0) return items;
  const call: ToolCallViewModel = {
    id: 'bild:' + eintrag.id, tool: 'Bild', action: '', agent: 'Hauptagent', status: 'done', argsPreview: '', resultPreview: '', error: '',
    durationMs: 0, createdAt: eintrag.erstellt_am, bilder, source: 'stream',
  };
  const lauf = items[ziel].toolRun ?? { calls: [], phases: [] };
  if (lauf.calls.some((c) => c.id === call.id)) return items;
  return items.map((m, i) => i === ziel ? { ...m, toolRun: { ...lauf, calls: [...lauf.calls, call] } } : m);
}

export function warteText(meta: Record<string, unknown> | null | undefined): string {
  const w = (meta?.warteschlange && typeof meta.warteschlange === 'object' ? meta.warteschlange : {}) as { art?: string; grund?: string };
  const grund = w.grund ? (WARTE_GRUND[w.grund] ?? w.grund) : 'nicht erreichbar';
  return w.art === 'einwurf'
    ? '⏳ Als Einwurf zugestellt – der Hauptagent ' + grund + '. Die Antwort erscheint hier von selbst.'
    : '⏳ Wartet auf den Hauptagenten (' + grund + '). Die Antwort erscheint hier von selbst – nicht erneut senden.';
}

export function baueVerlaufNachrichten(eintraege: MainAgentVerlaufEintrag[]): AgentMessage[] {
  const auftraege = new Map(eintraege.filter((eintrag) => eintrag.rolle === 'user' || eintrag.rolle === 'nachricht').map((eintrag) => [eintrag.id, eintrag.text]));
  let items: AgentMessage[] = [];
  for (const eintrag of eintraege) {
    // Sitzungs-Eintraege (Eingaben, Werkzeugschritte der CLI-Sitzung) sind Zaehl- und Uebergabebasis, keine Chatnachrichten.
    if (eintrag.gehoert_zu || eintrag.quelle_ref?.startsWith('jsonl:')) {
      items = haengeMetaBilderAn(items, eintrag);
      continue;
    }
    if (eintrag.rolle === 'user') {
      const zitate = anzeigeAusAnhaengen(eintrag.anhaenge);
      items.push({ id: verlaufAnzeigeId(eintrag.id), role: 'user', kind: 'text', text: eintrag.text, info: verlaufInfo(eintrag), ...(zitate.length ? { zitate } : {}) });
      continue;
    }
    if (eintrag.rolle === 'nachricht') {
      const von = eintrag.absender?.agent_id || 'unbekannt';
      items.push({ id: verlaufAnzeigeId(eintrag.id), role: 'user', kind: 'text', text: eintrag.text, info: verlaufInfo(eintrag),
        kopf: von + ' · ' + eintrag.weg + (eintrag.absender?.channel ? ' #' + eintrag.absender.channel : '') });
      continue;
    }
    if (eintrag.rolle === 'system' || eintrag.rolle === 'ausgabe') {
      items.push({ id: verlaufAnzeigeId(eintrag.id), role: 'agent', kind: 'text', text: eintrag.text, info: verlaufInfo(eintrag),
        kopf: eintrag.rolle === 'system' ? 'System · ' + eintrag.weg : 'Hauptagent · ' + eintrag.weg, hinweise: eintrag.hinweise?.length ? eintrag.hinweise : undefined });
      continue;
    }
    items.push({
      id: verlaufAnzeigeId(eintrag.id), role: 'agent', kind: 'text', text: eintrag.status === 'wartet' && !eintrag.text ? warteText(eintrag.meta) : eintrag.text,
      info: verlaufInfo(eintrag), toolRun: verlaufWerkzeuge(eintrag), laeuft: eintrag.status === 'laeuft', hinweise: eintrag.hinweise?.length ? eintrag.hinweise : undefined,
      zugInfo: verlaufZugInfo(eintrag),
    });
    (eintrag.artefakte ?? []).forEach((block, index) => {
      items = setzeArtefaktBlock(items, block, {
        artefaktId: verlaufAnzeigeId(eintrag.id, true), nummer: index + 1, titel: block.title || 'HTML-Antwort des Hauptagenten',
        auftrag: (eintrag.antwort_auf && auftraege.get(eintrag.antwort_auf)) || '',
      });
    });
  }
  return items;
}
