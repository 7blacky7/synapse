/**
 * P22-T288 W5 (Analyse efbe02f1): Startkontext auch auf dem ALTWEG des Main (docker exec je Turn, kein Runtime-Daemon). Bisher bekam
 * nur der Wrapper-Weg den Startkontext (System-Prompt-Route agent-wissen.ts -> startkontextFuer); mainStartkontext hatte 0 Aufrufer.
 * REGEL: nur bei NEUER CLI-Sitzung (kein runtimeSessionId - bei --resume/resume liegt der Kontext schon in der Sitzung) und nur fuer
 *   eine Session, die an die Main-Identitaet gebunden ist. Text aus core mainStartkontext (baueStartkontext, Schalter startkontext,
 *   Nachweis startkontext_offen wie auf dem Wrapper-Weg). Kein eigener Schalter (Fehlerbehebung, folgt startkontext).
 * DEBUG: runtime-Ereignis { startkontext: { weg: 'altweg', zuege, tokens } } bzw. { weg: 'altweg', grund }. Wirft nie.
 */
import { hauptagentIdentitaetsId, mainStartkontext } from '@synapse/core';
import type { MainAgentSession, RuntimeStreamEvent } from './types.js';

export type AltwegStartkontextQuellen = {
  mainId?: () => Promise<string | null>;
  startkontext?: (identityId: string) => Promise<{ text: string; zuege: number; tokens: number } | null>;
};

export async function altwegStartkontext(session: Pick<MainAgentSession, 'runtimeSessionId' | 'identityId'>, emit: (event: RuntimeStreamEvent) => void,
  q: AltwegStartkontextQuellen = {}): Promise<string | null> {
  if (session.runtimeSessionId || !session.identityId) return null;
  try {
    const main = await (q.mainId ?? hauptagentIdentitaetsId)();
    if (!main || main !== session.identityId) return null;
    const sk = await (q.startkontext ?? mainStartkontext)(session.identityId);
    emit({ event: 'runtime', data: { startkontext: sk ? { weg: 'altweg', zuege: sk.zuege, tokens: sk.tokens } : { weg: 'altweg', grund: 'leer_oder_schalter_aus' } } });
    return sk?.text ?? null;
  } catch (error) {
    emit({ event: 'runtime', data: { startkontext: { weg: 'altweg', grund: 'fehler', meldung: String((error as Error)?.message ?? error).slice(0, 200) } } });
    return null;
  }
}

/** Prompt der ersten Nachricht einer neuen Sitzung ohne System-Prompt-Option (Codex exec): Startkontext vor die Nachricht. Rein. */
export function mitStartkontext(message: string, startkontext: string | null): string {
  return startkontext ? startkontext + '\n\n## AKTUELLE NACHRICHT\n\n' + message : message;
}
