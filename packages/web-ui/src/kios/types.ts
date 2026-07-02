/**
 * KIOS-1: Typen + Quell-Vertrag fuer die Rendering-Pipeline.
 *
 * ChatRendering spiegelt die geplante PG-Tabelle chat_renderings
 * (vision-webui-ki-2026-06-25). RenderingSource ist der Vertrag zwischen UI
 * und Datenquelle: heute MockRenderingSource, spaeter eine REST/SSE-
 * Implementierung gegen die Server-KI — die UI-Komponenten bleiben identisch.
 */

export interface ChatRendering {
  id: string;
  conversationId: string;
  messageId: string | null;
  htmlContent: string;
  sequenceOrder: number;
  interactive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KiosMessage {
  id: string;
  role: 'ki' | 'user' | 'system';
  text: string;
  ts: string;
}

export type KiosEvent =
  | { type: 'message'; message: KiosMessage }
  | { type: 'rendering_new'; rendering: ChatRendering }
  | { type: 'rendering_update'; rendering: ChatRendering }
  | { type: 'busy'; busy: boolean };

export interface KiosAction {
  renderingId: string;
  action: string;
  value?: string;
}

/** Vertrag der Rendering-Quelle — Mock heute, Server-KI morgen. */
export interface RenderingSource {
  subscribe(cb: (ev: KiosEvent) => void): () => void;
  startScenario(name: string): void;
  respond(action: KiosAction): void;
  reset(): void;
}
