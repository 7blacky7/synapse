import type { MockChatAttachment } from '../ChatAttachments';
import type { ToolCallViewModel } from '../../control-plane/view-model';
import type { AnzeigeZitat } from '../zitat-logik';

export interface AgentHtmlBlock {
  id: string;
  html: string;
  column: number;
  columnSpan: number;
  row: number;
  rowSpan: number;
  minHeight: number;
  revision?: string | number;
  interactive?: boolean;
}

export interface AgentHtmlLayout {
  columns: number;
  rowHeight: number;
  gap: number;
}

export interface AgentMessage {
  id: number;
  role: 'user' | 'agent';
  kind: 'text' | 'artifact' | 'attachment';
  text: string;
  attachment?: MockChatAttachment;
  title?: string;
  blocks?: AgentHtmlBlock[];
  layout?: AgentHtmlLayout;
  saved?: boolean;
  mock?: boolean;
  /** P8-T25: Werkzeugaufrufe und Denkphasen dieser Antwort aus dem Antwortstrom. */
  toolRun?: { calls: ToolCallViewModel[]; phases: string[] };
  /** P22-T63: Kopfzeilen-Zusatz aus dem Verlauf (Geraet · Zeit). */
  info?: string;
  /** P22-T63: Antwort laeuft noch (aus dem Verlauf, z. B. auf einem anderen Geraet gestartet). */
  laeuft?: boolean;
  /** P22-T63: Fehler-/Hinweiszeilen der Antwort aus dem Verlauf. */
  hinweise?: string[];
  /** P22-T63: nur in diesem Tab (Verlauf aus bzw. noch ohne Server-ID). */
  lokal?: boolean;
  /** P22-T63: eigener Turn dieses Tabs mit Server-ID; bleibt stehen, bis der Verlauf ihn selbst liefert. */
  eigen?: boolean;
  /** P22-T63: Kopfzeile statt Du/Hauptagent (Nachrichten anderer Absender, Systemzeilen). */
  kopf?: string;
  /** P22-T63: Zugdaten der Antwort (Modell · Zuege · Dauer · in/out · Kontext). */
  zugInfo?: string;
  /** P22-T168: Zitat-Anhaenge der User-Nachricht (Verlauf anhaenge bzw. eigener Turn). */
  zitate?: AnzeigeZitat[];
}
