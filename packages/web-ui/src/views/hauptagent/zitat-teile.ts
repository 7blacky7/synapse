import type { AgentMessage } from '../../components/gemeinsam/agent-nachrichten-typen';
import { zerlegeZitatBlock, type AnzeigeZitat } from '../../components/zitat-logik';

/** P22-T168: Text ohne Zitat-Block und alle Zitate einer Nachricht (Anhaenge der Verlaufszeile bzw. Block im Text). */
export function zitatTeile(message: AgentMessage): { text: string; zitate: AnzeigeZitat[] } {
  if (message.kind !== 'text' || message.laeuft) return { text: message.text, zitate: message.zitate ?? [] };
  const z = zerlegeZitatBlock(message.text);
  return { text: z.text, zitate: [...(message.zitate ?? []), ...z.zitate] };
}