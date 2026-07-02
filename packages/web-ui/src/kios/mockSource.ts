/**
 * KIOS-1: MockRenderingSource — simuliert die Server-KI + chat_renderings.
 *
 * Szenario 'projekt-briefing': die "KI" zerlegt einen Auftrag in drei
 * sequenzielle Renderings (Statusboard, Architektur, Entscheidung), schiebt
 * spaeter ein UPDATE auf Rendering 1 nach (Live-Statusboard-Prinzip) und
 * reagiert auf Interaktionen (respond) mit einem UPDATE des Entscheidungs-
 * Renderings + Folgenachricht. Alles in-memory, kein Netz, kein Backend.
 */

import type { ChatRendering, KiosAction, KiosEvent, RenderingSource } from './types';

const uid = (): string => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
const now = (): string => new Date().toISOString();

const CONV = 'demo-conversation';

function boardHtml(backlog: number, updated: boolean): string {
  return `
<style>
  h3{margin:0 0 3px;font-size:15px;font-weight:600;letter-spacing:.3px}
  .sub{color:#7d88ad;font-size:12px;margin:0 0 14px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{color:#7d88ad;font-weight:600;text-align:left;padding:7px 10px;border-bottom:1px solid #232a44;font-size:10.5px;text-transform:uppercase;letter-spacing:.9px}
  td{padding:9px 10px;text-align:left;vertical-align:middle}
  tr+tr td{border-top:1px solid #1a2140}
  .bar{height:6px;border-radius:3px;background:#1a2140;overflow:hidden;min-width:130px}
  .bar i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,#5b8cff,#3ddc84);width:0;animation:fill 1s .15s ease-out forwards}
  @keyframes fill{to{width:var(--w)}}
  .badge{display:inline-block;padding:2px 9px;border-radius:10px;font-size:11px;white-space:nowrap}
  .run{background:rgba(61,220,132,.12);color:#3ddc84}
  .idle{background:rgba(125,136,173,.14);color:#9fb0d8}
  .num{font-variant-numeric:tabular-nums;color:#9fb0d8}
</style>
<h3>Projekt-Statusboard</h3>
<p class="sub">${updated ? 'live aktualisiert — Backlog-Lauf fortgeschritten' : 'Stand jetzt · 3 Projekte im Blick'}</p>
<table>
  <tr><th>Projekt</th><th>Dateien</th><th>Index-Backlog</th><th>Status</th></tr>
  <tr><td>synapse</td><td class="num">340</td><td><div class="bar"><i style="--w:${backlog}%"></i></div></td><td><span class="badge run">laeuft</span></td></tr>
  <tr><td>moo</td><td class="num">412</td><td><div class="bar"><i style="--w:100%"></i></div></td><td><span class="badge run">laeuft</span></td></tr>
  <tr><td>kumavision-evalink-bridge</td><td class="num">57</td><td><div class="bar"><i style="--w:88%"></i></div></td><td><span class="badge idle">aktiviert</span></td></tr>
</table>`;
}

const ARCH_HTML = `
<style>
  h3{margin:0 0 3px;font-size:15px;font-weight:600}
  .sub{color:#7d88ad;font-size:12px;margin:0 0 12px}
  svg{width:100%;height:auto;display:block}
  .box{fill:#141b36;stroke:#2b3766;rx:8}
  .lbl{fill:#dbe3ff;font-size:12px;font-weight:600}
  .meta{fill:#7d88ad;font-size:9.5px}
  .flow{stroke:#5b8cff;stroke-width:1.4;fill:none;stroke-dasharray:5 6;animation:dash 1.4s linear infinite;opacity:.75}
  .core{animation:pulse 2.8s ease-in-out infinite;transform-origin:center}
  @keyframes dash{to{stroke-dashoffset:-22}}
  @keyframes pulse{50%{opacity:.5}}
</style>
<h3>Synapse — Datenfluss (live)</h3>
<p class="sub">PostgreSQL als Source of Truth, Qdrant als Vektor-Index</p>
<svg viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg">
  <rect class="box" x="250" y="92" width="140" height="56"/>
  <circle class="core" cx="268" cy="120" r="5" fill="#e94560"/>
  <text class="lbl" x="284" y="116">REST-API</text>
  <text class="meta" x="284" y="132">synapse-api · Unraid</text>
  <rect class="box" x="30" y="24" width="150" height="52"/>
  <text class="lbl" x="48" y="46">PostgreSQL</text>
  <text class="meta" x="48" y="62">Source of Truth</text>
  <rect class="box" x="30" y="160" width="150" height="52"/>
  <text class="lbl" x="48" y="182">Qdrant</text>
  <text class="meta" x="48" y="198">Vektor-Index · 3072d</text>
  <rect class="box" x="470" y="24" width="150" height="52"/>
  <text class="lbl" x="488" y="46">Web-UI</text>
  <text class="meta" x="488" y="62">Chat · Graph · KIOS</text>
  <rect class="box" x="470" y="160" width="150" height="52"/>
  <text class="lbl" x="488" y="182">FileWatcher-Daemon</text>
  <text class="meta" x="488" y="198">User-PC · Shell-Queue</text>
  <path class="flow" d="M180 50 C 220 50 230 100 252 106"/>
  <path class="flow" d="M180 186 C 220 186 230 140 252 134"/>
  <path class="flow" d="M390 106 C 420 96 430 60 468 52"/>
  <path class="flow" d="M390 134 C 420 144 430 180 468 186"/>
</svg>`;

function decisionHtml(): string {
  return `
<style>
  h3{margin:0 0 3px;font-size:15px;font-weight:600}
  p{margin:0 0 14px;color:#aab6dc;font-size:13.5px;line-height:1.55}
  code{background:#1a2140;border:1px solid #2b3766;border-radius:5px;padding:1px 6px;font-size:12px;color:#8fb0ff}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
  .btn{cursor:pointer;border:1px solid #2b3766;background:#141b36;color:#dbe3ff;padding:9px 16px;border-radius:8px;font-size:13px;font-family:inherit;transition:border-color .15s,transform .1s}
  .btn:hover{border-color:#5b8cff;transform:translateY(-1px)}
  .primary{background:#5b8cff;border-color:#5b8cff;color:#fff}
  .primary:hover{border-color:#7ea4ff}
  input{flex:1;min-width:200px;background:#0f1428;border:1px solid #2b3766;border-radius:8px;color:#dbe3ff;padding:9px 12px;font-size:13px;font-family:inherit;outline:none}
  input:focus{border-color:#5b8cff}
</style>
<h3>Entscheidung noetig</h3>
<p>Branch <code>nacht-session/graph-3d-space</code> ist gebaut, deployed und reviewt. Wie soll ich weitermachen?</p>
<div class="row">
  <button class="btn primary" data-kios-action="mergen">Nach main mergen</button>
  <button class="btn" data-kios-action="warten">Noch warten</button>
  <button class="btn" data-kios-action="details">Mehr Details</button>
</div>
<div class="row">
  <input data-kios-input placeholder="Optionale Anmerkung…"/>
  <button class="btn" data-kios-action="antwort">Senden</button>
</div>`;
}

function answeredHtml(action: string, value?: string): string {
  const note = value ? `<p class="note">Anmerkung: „${value}“</p>` : '';
  return `
<style>
  .done{display:flex;align-items:center;gap:10px}
  .check{width:26px;height:26px;border-radius:50%;background:rgba(61,220,132,.14);color:#3ddc84;display:flex;align-items:center;justify-content:center;font-size:15px}
  h3{margin:0;font-size:14.5px;font-weight:600}
  .sub{color:#7d88ad;font-size:12px;margin:4px 0 0}
  .note{color:#aab6dc;font-size:12.5px;margin:10px 0 0;border-left:2px solid #2b3766;padding-left:10px}
</style>
<div class="done">
  <div class="check">✓</div>
  <div>
    <h3>Beantwortet: „${action}“</h3>
    <p class="sub">Punkt geschlossen — ich habe uebernommen und arbeite weiter.</p>
  </div>
</div>
${note}`;
}

export class MockRenderingSource implements RenderingSource {
  private listeners = new Set<(ev: KiosEvent) => void>();
  private timers: number[] = [];
  private renderings = new Map<string, ChatRendering>();
  private seq = 0;

  subscribe(cb: (ev: KiosEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(ev: KiosEvent): void {
    for (const cb of this.listeners) cb(ev);
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(window.setTimeout(fn, ms));
  }

  private message(role: 'ki' | 'user' | 'system', text: string): void {
    this.emit({ type: 'message', message: { id: uid(), role, text, ts: now() } });
  }

  private newRendering(html: string, interactive = false): ChatRendering {
    const r: ChatRendering = {
      id: uid(), conversationId: CONV, messageId: null,
      htmlContent: html, sequenceOrder: ++this.seq,
      interactive, createdAt: now(), updatedAt: now(),
    };
    this.renderings.set(r.id, r);
    this.emit({ type: 'rendering_new', rendering: r });
    return r;
  }

  private updateRendering(id: string, html: string, interactive?: boolean): void {
    const old = this.renderings.get(id);
    if (!old) return;
    const r: ChatRendering = { ...old, htmlContent: html, interactive: interactive ?? old.interactive, updatedAt: now() };
    this.renderings.set(id, r);
    this.emit({ type: 'rendering_update', rendering: r });
  }

  startScenario(name: string): void {
    if (name !== 'projekt-briefing') return;
    this.emit({ type: 'busy', busy: true });
    let boardId = '';
    let decisionId = '';
    this.later(400, () => this.message('ki', 'Auftrag angenommen. Ich zerlege das in drei Renderings: Statusboard, Datenfluss, offene Entscheidung — sie bauen sich nacheinander auf, waehrend ich am naechsten arbeite.'));
    this.later(1500, () => { boardId = this.newRendering(boardHtml(38, false)).id; });
    this.later(5600, () => this.newRendering(ARCH_HTML));
    this.later(10200, () => { decisionId = this.newRendering(decisionHtml(), true).id; (this as any)._decisionId = decisionId; });
    this.later(10400, () => {
      this.message('ki', 'Das Briefing steht. Das Statusboard halte ich live — und beim dritten Rendering brauche ich dich.');
      this.emit({ type: 'busy', busy: false });
    });
    this.later(14500, () => { if (boardId) this.updateRendering(boardId, boardHtml(81, true)); });
  }

  respond(action: KiosAction): void {
    const label = action.action + (action.value ? ` — „${action.value}“` : '');
    this.message('user', label);
    this.later(700, () => this.updateRendering(action.renderingId, answeredHtml(action.action, action.value), false));
    this.later(1500, () => this.message('ki', `Verstanden: „${action.action}“. Ich habe den Punkt als beantwortet markiert — genau so wuerde ich nachts weiterarbeiten und dir das Ergebnis in den Feed legen.`));
  }

  reset(): void {
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
    this.renderings.clear();
    this.seq = 0;
  }
}
