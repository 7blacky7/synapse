/**
 * GRAPH-2: GraphEngine — die portierte synapse-graph-Logik, gekapselt.
 *
 * Baut ihr komplettes DOM (Header-Tabs, Ebenen-Menue, Sidebar, Cytoscape-
 * Container, Timeline, Detail-Panel, Legende, Footer) IN das uebergebene
 * Root-Element. Cytoscape + Cosmos-Canvas leben in eigenen divs -> keine
 * Kollision mit Reacts virtuellem DOM (React fasst nur das aeussere host-div
 * an, alles darunter gehoert der Engine).
 *
 * Datenzugriff ausschliesslich ueber graph/api.ts (apiFetch -> Auth transparent).
 * Render-/Layout-/Legenden-Logik 1:1 aus synapse-graph/public/app.js portiert.
 */

import cytoscape, { Core, NodeSingular } from 'cytoscape';
import {
  POLL_MS, EXT_COLORS, SYM_COLORS, TASK_COLORS, MEM_COLORS, KIND_BASE,
  EXT_NAMES, SYM_NAMES, TL_COLORS, TL_NAMES, colorFor, sizeFor,
} from './constants';
import * as api from './api';
import { CosmosRenderer } from './cosmos';

type View = 'code' | 'knowledge' | 'timeline';
type Mode = 'overview' | 'project';

interface EngineState {
  mode: Mode;
  view: View;
  project: string | null;
  lastHash: string;
  selected: string | null;
  coreExpanded: boolean;
  coreJustExpanded: boolean;
}

const SYM_LAYER_KEYS = ['function', 'variable', 'string', 'class', 'interface', 'todo', 'route', 'table'];
const KNOW_LAYER_KEYS = ['tasks', 'memories', 'thoughts', 'proposals', 'tags'];

export class GraphEngine {
  private root: HTMLElement;
  private cy: Core;
  private cosmos: CosmosRenderer;
  private state: EngineState;
  private detailAbort: AbortController | null = null;
  private pollTimer: number | null = null;
  private resizeHandler: () => void;
  private destroyed = false;

  // DOM-Referenzen (statt document.querySelector globalen)
  private elBack!: HTMLButtonElement;
  private elTabs!: HTMLElement;
  private elTabCode!: HTMLButtonElement;
  private elTabKnow!: HTMLButtonElement;
  private elTabTime!: HTMLButtonElement;
  private elBreadcrumb!: HTMLElement;
  private elProjects!: HTMLElement;
  private elCy!: HTMLElement;
  private elStars!: HTMLCanvasElement;
  private elTimeline!: HTMLElement;
  private elPanel!: HTMLElement;
  private elLegendBody!: HTMLElement;
  private elStatus!: HTMLElement;
  private elCounts!: HTMLElement;
  private elLive!: HTMLElement;
  private elMotion!: HTMLInputElement;
  private elLayersCode!: HTMLElement;
  private elLayersKnow!: HTMLElement;
  private elLayersUniverse!: HTMLElement;
  private symInputs: HTMLInputElement[] = [];
  private knowInputs: HTMLInputElement[] = [];
  private elExternals!: HTMLInputElement;

  constructor(root: HTMLElement, initialProject: string) {
    this.root = root;
    this.state = {
      mode: 'overview', view: 'code', project: initialProject || null,
      lastHash: '', selected: null, coreExpanded: false, coreJustExpanded: false,
    };
    this.buildDom();
    this.cy = this.createCy();
    this.elStars = document.createElement('canvas');
    this.elStars.className = 'sg-stars';
    this.elCy.appendChild(this.elStars);
    this.cosmos = new CosmosRenderer({
      cy: this.cy,
      container: this.elCy,
      canvas: this.elStars,
      motionEnabled: () => !!this.elMotion?.checked,
      getMode: () => this.state.mode,
    });
    this.wireHandlers();
    this.resizeHandler = () => this.cosmos.resize();
    window.addEventListener('resize', this.resizeHandler);
    this.buildLegend('overview');
    this.refresh(true);
    this.pollTimer = window.setInterval(() => this.refresh(), POLL_MS);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.pollTimer != null) window.clearInterval(this.pollTimer);
    if (this.detailAbort) this.detailAbort.abort();
    window.removeEventListener('resize', this.resizeHandler);
    this.cosmos.destroy();
    this.cy.destroy();
    this.root.replaceChildren();
  }

  /** Projekt-Wechsel von aussen (React-Prop). */
  setProject(name: string): void {
    if (!name || name === this.state.project) return;
    this.state.project = name;
    if (this.state.mode === 'project') {
      this.state.lastHash = '';
      this.clearDetails();
      this.refresh(true);
    }
  }

  // -------------------------------------------------------------------------
  // DOM-Aufbau (entspricht index.html, aber programmatisch + scoped Klassen)
  // -------------------------------------------------------------------------
  private el<K extends keyof HTMLElementTagNameMap>(
    tag: K, opts: { text?: string; cls?: string; id?: string } = {},
  ): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (opts.text != null) e.textContent = opts.text;
    if (opts.cls) e.className = opts.cls;
    if (opts.id) e.id = opts.id;
    return e;
  }

  private checkbox(attr: 'data-sym' | 'data-know' | 'id', value: string, label: string, checked = false): HTMLLabelElement {
    const lab = this.el('label');
    const inp = this.el('input');
    inp.type = 'checkbox';
    if (attr === 'id') inp.id = value;
    else inp.setAttribute(attr, value);
    inp.checked = checked;
    lab.append(inp, document.createTextNode(' ' + label));
    return lab;
  }

  private buildDom(): void {
    this.root.classList.add('sg-host');
    this.root.replaceChildren();

    // Header
    const header = this.el('header', { cls: 'sg-header' });
    this.elBack = this.el('button', { cls: 'sg-back', text: '← Übersicht' });
    this.elBack.style.display = 'none';
    const h1 = this.el('h1', { cls: 'sg-title' });
    h1.append(this.el('span', { text: 'Synapse' }), document.createTextNode(' Graph'));
    this.elTabs = this.el('div', { cls: 'sg-tabs' });
    this.elTabs.style.display = 'none';
    this.elTabCode = this.el('button', { cls: 'sg-tab active', text: 'Code' });
    this.elTabKnow = this.el('button', { cls: 'sg-tab', text: 'Wissen' });
    this.elTabTime = this.el('button', { cls: 'sg-tab', text: 'Chronik' });
    this.elTabs.append(this.elTabCode, this.elTabKnow, this.elTabTime);
    this.elBreadcrumb = this.el('div', { cls: 'sg-breadcrumb', text: 'Übersicht aller Projekte' });

    // Ebenen-Menue
    const layers = this.el('details', { cls: 'sg-layers' });
    const summary = this.el('summary', { text: 'Ebenen ▾' });
    layers.append(summary);
    const menu = this.el('div', { cls: 'sg-menu' });

    this.elLayersUniverse = this.el('div', { cls: 'sg-layer-group' });
    this.elLayersUniverse.append(this.el('h5', { text: 'Universum' }));
    const motionLabel = this.checkbox('id', 'sg-motion', 'Bewegung (Orbits)', true);
    this.elMotion = motionLabel.querySelector('input')!;
    this.elLayersUniverse.append(motionLabel);

    this.elLayersCode = this.el('div', { cls: 'sg-layer-group' });
    this.elLayersCode.style.display = 'none';
    this.elLayersCode.append(this.el('h5', { text: 'Code-Ebenen' }));
    for (const k of SYM_LAYER_KEYS) {
      const lab = this.checkbox('data-sym', k, SYM_NAMES[k] ?? k);
      this.symInputs.push(lab.querySelector('input')!);
      this.elLayersCode.append(lab);
    }
    const extLabel = this.checkbox('id', 'sg-externals', 'externe Pakete');
    this.elExternals = extLabel.querySelector('input')!;
    this.elLayersCode.append(extLabel);

    this.elLayersKnow = this.el('div', { cls: 'sg-layer-group' });
    this.elLayersKnow.style.display = 'none';
    this.elLayersKnow.append(this.el('h5', { text: 'Wissens-Ebenen' }));
    const knowLabels: Record<string, string> = {
      tasks: 'Tasks', memories: 'Memories', thoughts: 'Thoughts',
      proposals: 'Proposals', tags: 'Tag-Verknüpfungen',
    };
    for (const k of KNOW_LAYER_KEYS) {
      const lab = this.checkbox('data-know', k, knowLabels[k], true);
      this.knowInputs.push(lab.querySelector('input')!);
      this.elLayersKnow.append(lab);
    }

    menu.append(this.elLayersUniverse, this.elLayersCode, this.elLayersKnow);
    layers.append(menu);

    header.append(this.elBack, h1, this.elTabs, this.elBreadcrumb, layers);

    // Sidebar
    const sidebar = this.el('nav', { cls: 'sg-sidebar' });
    sidebar.append(this.el('h2', { text: 'Projekte (live)' }));
    this.elProjects = this.el('div', { cls: 'sg-projects' });
    sidebar.append(this.elProjects);

    // Cytoscape-Container
    this.elCy = this.el('div', { cls: 'sg-cy' });

    // Timeline-Overlay
    this.elTimeline = this.el('div', { cls: 'sg-timeline' });
    this.elTimeline.style.display = 'none';

    // Detail-Panel
    this.elPanel = this.el('aside', { cls: 'sg-panel' });
    this.elPanel.style.display = 'none';

    // Legende
    const legend = this.el('details', { cls: 'sg-legend' });
    legend.append(this.el('summary', { text: 'Legende ▾' }));
    this.elLegendBody = this.el('div', { cls: 'sg-legend-body' });
    legend.append(this.elLegendBody);

    // Footer
    const footer = this.el('footer', { cls: 'sg-footer' });
    this.elLive = this.el('span', { cls: 'sg-live', text: '● live' });
    this.elStatus = this.el('span', { cls: 'sg-status', text: 'verbinde …' });
    this.elCounts = this.el('span', { cls: 'sg-counts' });
    const hint = this.el('span', { cls: 'sg-hint', text: 'Rechtsklick: Layout entzerren · Rechtsklick auf Knoten: Nachbarn auffächern' });
    footer.append(this.elLive, this.elStatus, this.elCounts, hint);

    this.root.append(header, sidebar, this.elCy, this.elTimeline, this.elPanel, legend, footer);
  }

  // -------------------------------------------------------------------------
  // Cytoscape-Setup (Style 1:1 aus app.js)
  // -------------------------------------------------------------------------
  private createCy(): Core {
    return cytoscape({
      container: this.elCy,
      wheelSensitivity: 0.25,
      style: [
        { selector: 'node', style: {
          label: 'data(label)', color: '#d6dcf5', 'font-size': 9,
          'min-zoomed-font-size': 8,
          'text-valign': 'bottom', 'text-margin-y': 4,
          'background-color': 'data(color)', width: 'data(size)', height: 'data(size)',
          'border-width': 3, 'border-color': 'data(color)', 'border-opacity': 0.3,
        } },
        { selector: 'node[type = "project"]', style: {
          'font-size': 12, 'font-weight': 600,
          'background-opacity': 0, 'border-width': 0,
        } },
        { selector: 'node[type = "center"]', style: { shape: 'hexagon', 'font-size': 14, 'font-weight': 700 } },
        { selector: 'node[hole = "black"]', style: {
          shape: 'ellipse', 'border-width': 5, 'border-color': '#ff9800', 'border-opacity': 0.85,
          color: '#ffb74d', 'font-size': 13,
        } },
        { selector: 'node[hole = "white"]', style: {
          shape: 'ellipse', 'border-width': 5, 'border-color': '#9db8ff', 'border-opacity': 0.9,
          color: '#eaf2ff', 'font-size': 13,
        } },
        { selector: 'node[type = "external"]', style: { shape: 'diamond', 'font-size': 8 } },
        { selector: 'node[type = "symbol"]', style: { shape: 'triangle', 'font-size': 7, 'border-width': 2, 'border-opacity': 0.35, opacity: 0.95 } },
        { selector: 'node[type = "ghost"]', style: {
          'border-width': 1, 'border-style': 'dashed', 'border-color': '#2dd4bf',
          'background-opacity': 0.25, 'font-size': 8,
        } },
        { selector: 'node[kind = "project"]', style: { shape: 'hexagon', 'font-size': 13, 'font-weight': 700 } },
        { selector: 'node[kind = "plan"]', style: { shape: 'star', 'font-size': 11, 'font-weight': 600 } },
        { selector: 'node[kind = "task"]', style: { shape: 'round-rectangle' } },
        { selector: 'node[kind = "memory"]', style: { shape: 'barrel', 'font-size': 10 } },
        { selector: 'node[kind = "thought"]', style: { shape: 'ellipse', 'font-size': 8 } },
        { selector: 'node[kind = "proposal"]', style: { shape: 'tag' } },
        { selector: 'node[kind = "tag"]', style: { shape: 'diamond', 'font-size': 8, color: '#7d88ad' } },
        { selector: 'edge', style: {
          width: 1.2, 'line-color': '#38436b', opacity: 0.7,
          'target-arrow-color': '#38436b', 'target-arrow-shape': 'triangle',
          'arrow-scale': 0.7, 'curve-style': 'bezier',
        } },
        { selector: 'edge[type = "external"]', style: { 'line-style': 'dashed', 'line-color': '#3a3f58' } },
        { selector: 'edge[type = "symbol"]', style: { 'line-color': '#26304f', 'target-arrow-shape': 'none', opacity: 0.5 } },
        { selector: 'edge[type = "tag"]', style: { 'line-style': 'dotted', 'line-color': '#475569', 'target-arrow-shape': 'none' } },
        { selector: 'edge[type = "semantic"]', style: {
          'line-style': 'dashed', 'line-color': '#2dd4bf', width: 2,
          'target-arrow-shape': 'none', opacity: 0.95,
        } },
        { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#ffffff' } },
      ],
    });
  }

  // -------------------------------------------------------------------------
  // Event-Wiring (Klicks + Layer-Toggles)
  // -------------------------------------------------------------------------
  private wireHandlers(): void {
    const cy = this.cy;
    cy.on('tap', 'node[type = "project"]', (ev) => this.enterProject(ev.target.id()));
    cy.on('tap', 'node[type = "center"]', () => {
      this.state.coreExpanded = !this.state.coreExpanded;
      this.state.coreJustExpanded = this.state.coreExpanded;
      this.state.lastHash = '';
      this.buildLegend('overview');
      this.refresh(true);
    });
    cy.on('tap', 'node[type = "file"]', (ev) => this.showFileDetails(ev.target.id()));
    cy.on('tap', 'node[type = "symbol"]', (ev) => this.showFileDetails(ev.target.data('file')));
    cy.on('tap', 'node[kind]', (ev) => {
      const k = ev.target.data('kind');
      if (['plan', 'task', 'memory', 'thought', 'proposal'].includes(k)) this.showKnowledgeDetails(ev.target);
    });
    cy.on('tap', (ev) => { if (ev.target === cy) this.clearDetails(); });

    this.elCy.addEventListener('contextmenu', (e) => e.preventDefault());
    cy.on('cxttap', 'node', (ev) => this.untangleNode(ev.target));
    cy.on('cxttap', (ev) => { if (ev.target === cy) this.untangleAll(); });

    this.elTabCode.addEventListener('click', () => this.setView('code'));
    this.elTabKnow.addEventListener('click', () => this.setView('knowledge'));
    this.elTabTime.addEventListener('click', () => this.setView('timeline'));
    this.elBack.addEventListener('click', () => this.goOverview());

    const allInputs = [this.elMotion, this.elExternals, ...this.symInputs, ...this.knowInputs];
    for (const input of allInputs) {
      input.addEventListener('change', () => {
        this.state.lastHash = '';
        this.buildLegend(this.state.mode === 'project' ? this.state.view : 'overview');
        this.refresh(true);
      });
    }
  }

  private symLayers(): string[] { return this.symInputs.filter((i) => i.checked).map((i) => i.getAttribute('data-sym')!); }
  private knowLayers(): string[] { return this.knowInputs.filter((i) => i.checked).map((i) => i.getAttribute('data-know')!); }

  // -------------------------------------------------------------------------
  // DOM-Helfer fuer Panel/Legende (entspricht el()/section() aus app.js)
  // -------------------------------------------------------------------------
  private mk(tag: string, text?: string | null, cls?: string): HTMLElement {
    const e = document.createElement(tag);
    if (text != null) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }

  private section(
    title: string,
    items: Array<string | { id: string; text: string }>,
    onClick?: (id: string) => void,
  ): HTMLElement {
    const wrap = this.mk('div', null, 'sg-sec');
    wrap.append(this.mk('h4', title));
    if (!items.length) {
      wrap.append(this.mk('p', '—'));
    } else {
      const ul = this.mk('ul');
      for (const it of items) {
        const li = this.mk('li', typeof it === 'string' ? it : it.text);
        if (onClick && typeof it !== 'string') {
          li.classList.add('sg-link');
          li.addEventListener('click', () => onClick(it.id));
        }
        ul.append(li);
      }
      wrap.append(ul);
    }
    return wrap;
  }

  // -------------------------------------------------------------------------
  // Details: Dateien
  // -------------------------------------------------------------------------
  private clearSemanticEdges(): void { this.cy.edges('[type = "semantic"]').remove(); }
  private clearOverlay(): void { this.clearSemanticEdges(); this.cy.nodes('[type = "ghost"]').remove(); }

  private clearDetails(): void {
    this.state.selected = null;
    this.clearOverlay();
    this.elPanel.style.display = 'none';
  }

  private async showFileDetails(fp: string): Promise<void> {
    if (this.state.mode !== 'project' || !fp || !this.state.project) return;
    this.state.selected = fp;
    this.clearOverlay();
    if (this.detailAbort) this.detailAbort.abort();
    this.detailAbort = new AbortController();
    const sig = this.detailAbort.signal;
    const panel = this.elPanel;
    panel.style.display = 'block';
    panel.replaceChildren(this.mk('h3', fp), this.mk('p', 'lade Zusammenhänge …'));
    try {
      const d = await api.fetchFileDetail(this.state.project, fp, sig);
      if (this.state.selected !== fp) return;
      const node = this.cy.getElementById(fp);
      const nonSym = (n: NodeSingular) => n.data('type') !== 'symbol';
      const out = node.outgoers('node').filter(nonSym).map((n) => ({ id: n.id(), text: (n.data('label') ?? n.id()) as string }));
      const inn = node.incomers('node').filter(nonSym).map((n) => ({ id: n.id(), text: (n.data('label') ?? n.id()) as string }));
      const focus = (id: string) => {
        const t = this.cy.getElementById(id);
        if (t.length && t.data('type') === 'file') this.showFileDetails(id);
      };
      panel.replaceChildren(this.mk('h3', fp));
      panel.append(this.section(`Importiert (${out.length})`, out, focus));
      panel.append(this.section(`Importiert von (${inn.length})`, inn, focus));
      panel.append(this.section(`Funktionen (${d.functions.length})`, d.functions.slice(0, 15)));
      panel.append(this.section(
        'Semantisch ähnlich (Qdrant)',
        d.semantic.map((s) => ({ id: s.filePath, text: `${s.filePath}  · ${s.score}` })),
        focus,
      ));
      panel.append(this.section(
        'Wissen (semantisch)',
        (d.knowledge ?? []).map((s) => `${s.kind === 'memory' ? 'Memory' : 'Thought'}: ${s.label}  · ${s.score}`),
      ));
      for (const s of d.semantic) {
        const t = this.cy.getElementById(s.filePath);
        if (!t.length || s.filePath === fp) continue;
        this.cy.add({ data: { id: `sem:${fp}→${s.filePath}`, source: fp, target: s.filePath, type: 'semantic' } });
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') panel.append(this.mk('p', `Fehler: ${(err as Error).message}`));
    }
  }

  // -------------------------------------------------------------------------
  // Details: Wissens-Knoten
  // -------------------------------------------------------------------------
  private async showKnowledgeDetails(node: NodeSingular): Promise<void> {
    if (!this.state.project) return;
    const id = node.id();
    const kind = node.data('kind');
    this.state.selected = id;
    this.clearOverlay();
    if (this.detailAbort) this.detailAbort.abort();
    this.detailAbort = new AbortController();
    const sig = this.detailAbort.signal;
    const panel = this.elPanel;
    panel.style.display = 'block';
    const title = `${kind}: ${node.data('label')}`;
    panel.replaceChildren(this.mk('h3', title), this.mk('p', 'lade Zusammenhänge …'));
    const ref = (node.data('refId') as string) ?? id.replace(/^(mem|tho|task|prop):/, '');
    const query = (node.data('meta') as string) || (node.data('label') as string) || '';
    try {
      const d = await api.fetchKnowledgeDetail(this.state.project, kind, ref, query, sig);
      if (this.state.selected !== id) return;
      panel.replaceChildren(this.mk('h3', title));
      const status = node.data('status');
      if (status) panel.append(this.mk('p', `Status: ${status}`));
      if (node.data('category')) panel.append(this.mk('p', `Kategorie: ${node.data('category')}`));
      if (node.data('source')) panel.append(this.mk('p', `Quelle: ${node.data('source')}`));
      const content = d.content || (node.data('meta') as string) || '';
      if (content) {
        const sec = this.mk('div', null, 'sg-sec');
        sec.append(this.mk('h4', 'Inhalt'));
        sec.append(this.mk('p', content.slice(0, 800)));
        panel.append(sec);
      }
      if (d.tags?.length) panel.append(this.section('Tags', d.tags.map((t) => `#${t}`)));
      if (d.linkedPaths?.length) panel.append(this.section('Verknüpfte Dateien', d.linkedPaths));
      const focusKnow = (nid: string) => {
        const t = this.cy.getElementById(nid);
        if (t.length && t.data('kind')) this.showKnowledgeDetails(t);
      };
      // GRAPH-1b liefert neighbors:[{nodeId,kind,label,score}] (ersetzt altes d.semantic).
      panel.append(this.section(
        'Semantisch ähnlich (Qdrant)',
        (d.neighbors ?? []).filter((s) => s.nodeId !== id).map((s) => ({ id: s.nodeId, text: `${s.label}  · ${s.score}` })),
        focusKnow,
      ));
      for (const s of d.neighbors ?? []) {
        if (s.nodeId === id) continue;
        const t = this.cy.getElementById(s.nodeId);
        if (!t.length) continue;
        this.cy.add({ data: { id: `sem:${id}→${s.nodeId}`, source: id, target: s.nodeId, type: 'semantic' } });
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') panel.append(this.mk('p', `Fehler: ${(err as Error).message}`));
    }
  }

  // -------------------------------------------------------------------------
  // Chronik
  // -------------------------------------------------------------------------
  private renderTimeline(items: api.TimelineItem[]): void {
    const box = this.elTimeline;
    box.replaceChildren();
    let lastDay = '';
    for (const it of items) {
      const d = it.ts ? new Date(it.ts) : null;
      const day = d ? d.toLocaleDateString('de-DE') : 'ohne Datum';
      if (day !== lastDay) {
        lastDay = day;
        box.append(this.mk('h4', day, 'sg-tl-day'));
      }
      const row = this.mk('div', null, 'sg-tl-row');
      const dot = this.mk('span', '●', 'sg-tl-dot');
      dot.style.color = TL_COLORS[it.type] ?? '#90a4ae';
      row.append(
        dot,
        this.mk('span', d ? d.toLocaleTimeString('de-DE') : '—', 'sg-tl-time'),
        this.mk('span', TL_NAMES[it.type] ?? it.type, 'sg-tl-kind'),
        this.mk('span', it.title, 'sg-tl-title'),
      );
      row.addEventListener('click', () => this.showTimelineDetails(it));
      box.append(row);
    }
    if (!items.length) box.append(this.mk('p', 'Keine Ereignisse gefunden.'));
  }

  private showTimelineDetails(it: api.TimelineItem): void {
    const panel = this.elPanel;
    panel.style.display = 'block';
    panel.replaceChildren(this.mk('h3', `${TL_NAMES[it.type] ?? it.type}: ${it.title}`));
    if (it.ts) panel.append(this.mk('p', new Date(it.ts).toLocaleString('de-DE')));
    if (it.detail) {
      const sec = this.mk('div', null, 'sg-sec');
      sec.append(this.mk('h4', 'Details'));
      sec.append(this.mk('p', it.detail));
      panel.append(sec);
    }
    if (it.files?.length) {
      panel.append(this.section(
        `Dateien (${it.files.length}) — Klick = Diff alt/neu`,
        it.files.map((f) => {
          const path = typeof f === 'string' ? f : f.path;
          return { id: path, text: path };
        }),
        (fp) => {
          const f = it.files!.find((x) => (typeof x === 'string' ? x : x.path) === fp);
          if (f && typeof f !== 'string' && f.version) {
            this.showDiff(it, f.path, f.version);
          } else {
            this.setView('code');
            window.setTimeout(() => this.showFileDetails(fp), 900);
          }
        },
      ));
    }
    // Shell-Output-Endpunkt (/shell-log) wurde in GRAPH-1 nicht portiert -> entfaellt.
  }

  private async showDiff(it: api.TimelineItem, filePath: string, versionId: string): Promise<void> {
    if (!this.state.project) return;
    const panel = this.elPanel;
    panel.replaceChildren(this.mk('h3', `Diff: ${filePath}`));
    const back = this.mk('p', '← zurück zum Ereignis', 'sg-link-row');
    back.addEventListener('click', () => this.showTimelineDetails(it));
    panel.append(back);
    const open = this.mk('p', '→ im Code-Graph öffnen', 'sg-link-row');
    open.addEventListener('click', () => {
      this.setView('code');
      window.setTimeout(() => this.showFileDetails(filePath), 900);
    });
    panel.append(open);
    const pre = this.mk('pre', 'lade Diff …', 'sg-tl-pre');
    panel.append(pre);
    try {
      const d = await api.fetchDiff(this.state.project, filePath, versionId);
      pre.replaceChildren();
      if (d.firstVersion) pre.append(this.mk('span', '(erste Version — alles neu)\n', 'sg-diff-ctx'));
      for (const l of d.diff ?? []) {
        const cls = l.t === '+' ? 'sg-diff-add' : l.t === '-' ? 'sg-diff-del' : 'sg-diff-ctx';
        pre.append(this.mk('span', (l.t === '~' ? '…' : `${l.t} ${l.line}`) + '\n', cls));
      }
      if (!(d.diff ?? []).length) pre.textContent = '(keine Änderungen)';
    } catch (e) {
      pre.textContent = `Fehler: ${(e as Error).message}`;
    }
  }

  // -------------------------------------------------------------------------
  // Legende
  // -------------------------------------------------------------------------
  private lgRow(sym: string, color: string, text: string): HTMLElement {
    const row = this.mk('div', null, 'sg-lg-row');
    const sw = this.mk('span', sym, 'sg-lg-swatch');
    sw.style.color = color;
    row.append(sw, this.mk('span', text));
    return row;
  }

  private lgLine(style: string, color: string, text: string): HTMLElement {
    const row = this.mk('div', null, 'sg-lg-row');
    const ln = this.mk('span', null, 'sg-lg-line');
    ln.style.borderTopStyle = style;
    ln.style.borderTopColor = color;
    row.append(ln, this.mk('span', text));
    return row;
  }

  private buildLegend(view: string): void {
    const body = this.elLegendBody;
    body.replaceChildren();
    if (view === 'overview') {
      body.append(this.mk('h5', 'Knoten'));
      if (this.state.coreExpanded) {
        body.append(this.lgRow('◉', '#eaf2ff', 'Weißes Loch — strahlt die Projekte aus (Klick schließt)'));
      } else {
        body.append(this.lgRow('●', '#ff9800', 'Schwarzes Loch — Projekte eingeklappt (Klick öffnet)'));
      }
      body.append(this.lgRow('●', '#7a5cc9', 'Projekt — Planet mit eigener Oberfläche'));
      body.append(this.lgRow('○', '#3ddc84', 'grün leuchtender Ring — läuft (Watcher aktiv)'));
      body.append(this.lgRow('○', '#5b8cff', 'blauer Ring — aktiviert'));
      body.append(this.lgRow('☀', '#ffcf6b', 'Sonnen (3 Sterntypen) — strahlen die nächsten Projekte an'));
      body.append(this.lgRow('↻', '#7d88ad', 'Orbits: Planeten + Sonnen kreisen — schaltbar im Ebenen-Menü'));
      body.append(this.lgRow('❄', '#bcd6f7', 'Eiswelten — fern aller Sonnen wachsen Frost + Polkappen'));
      body.append(this.lgRow('◯', '#7d88ad', 'Größe = Anzahl Dateien'));
    } else if (view === 'code') {
      const usedExts = new Set<string>();
      let hasOther = false;
      this.cy.nodes('[type = "file"]').forEach((n) => {
        const ext = n.data('ext');
        if (EXT_COLORS[ext]) usedExts.add(ext);
        else hasOther = true;
      });
      body.append(this.mk('h5', 'Dateien (Farbe = Typ)'));
      for (const [ext, color] of Object.entries(EXT_COLORS)) {
        if (!usedExts.has(ext)) continue;
        body.append(this.lgRow('●', color, `${EXT_NAMES[ext] ?? ext} (.${ext})`));
      }
      if (hasOther) body.append(this.lgRow('●', '#90a4ae', 'sonstige Datei'));
      body.append(this.lgRow('◯', '#7d88ad', 'Größe = Anzahl Funktionen'));
      const activeSyms = new Set(this.symLayers());
      if (activeSyms.size) {
        body.append(this.mk('h5', 'Symbole (Dreiecke — aktive Ebenen)'));
        for (const [t, color] of Object.entries(SYM_COLORS)) {
          if (!activeSyms.has(t)) continue;
          body.append(this.lgRow('▲', color, SYM_NAMES[t] ?? t));
        }
      }
      body.append(this.mk('h5', 'Weitere Knoten'));
      if (this.elExternals.checked) body.append(this.lgRow('◆', '#5c6685', 'externes Paket (npm etc.)'));
      body.append(this.lgRow('◌', '#2dd4bf', 'semantischer Treffer (Ghost, klickbar)'));
      body.append(this.mk('h5', 'Kanten'));
      body.append(this.lgLine('solid', '#5b6a99', 'Import (Pfeil = importiert von → zu)'));
      body.append(this.lgLine('dashed', '#5b6a99', 'Import eines externen Pakets'));
      if (activeSyms.size) body.append(this.lgLine('solid', '#3d4a78', 'Symbol gehört zu Datei'));
      body.append(this.lgLine('dashed', '#2dd4bf', 'semantisch ähnlich (Qdrant)'));
    } else if (view === 'timeline') {
      body.append(this.mk('h5', 'Ereignis-Typen'));
      for (const [t, color] of Object.entries(TL_COLORS)) {
        body.append(this.lgRow('●', color, TL_NAMES[t]));
      }
    } else {
      const kinds = new Set(this.cy.nodes('[kind]').map((n) => n.data('kind')));
      const statuses = new Set(this.cy.nodes('[kind = "task"]').map((n) => n.data('status')));
      const cats = new Set(this.cy.nodes('[kind = "memory"]').map((n) => n.data('category')));
      body.append(this.mk('h5', 'Knoten'));
      body.append(this.lgRow('⬢', '#5b8cff', 'Projekt'));
      if (kinds.has('plan')) body.append(this.lgRow('★', '#fbbf24', 'Projektplan'));
      if (kinds.has('task')) {
        body.append(this.mk('h5', 'Tasks (Rechtecke, Farbe = Status)'));
        const TASK_NAMES: Record<string, string> = {
          todo: 'todo — offen', in_progress: 'in_progress — in Arbeit',
          done: 'done — erledigt', blocked: 'blocked — blockiert',
        };
        for (const [s, label] of Object.entries(TASK_NAMES)) {
          if (statuses.has(s)) body.append(this.lgRow('▮', TASK_COLORS[s], label));
        }
      }
      if (kinds.has('memory')) {
        body.append(this.mk('h5', 'Memories (Fässer, Farbe = Kategorie)'));
        const CAT_NAMES: Record<string, string> = {
          rules: 'rules — Regeln', architecture: 'architecture — Architektur',
          decision: 'decision — Entscheidung', documentation: 'documentation — Doku',
          note: 'note — Notiz', other: 'other — Sonstiges',
        };
        for (const [c, label] of Object.entries(CAT_NAMES)) {
          if (cats.has(c)) body.append(this.lgRow('⬬', MEM_COLORS[c] ?? '#94a3b8', label));
        }
      }
      if (kinds.has('thought') || kinds.has('proposal') || kinds.has('tag')) {
        body.append(this.mk('h5', 'Weitere'));
        if (kinds.has('thought')) body.append(this.lgRow('●', '#67e8f9', 'Thought — Gedanke eines Agenten'));
        if (kinds.has('proposal')) body.append(this.lgRow('⬟', '#f472b6', 'Proposal — Änderungsvorschlag'));
        if (kinds.has('tag')) body.append(this.lgRow('◆', '#475569', '#Tag-Hub — verbindet Items mit gleichem Tag'));
      }
      body.append(this.lgRow('◌', '#2dd4bf', 'semantischer Code-Treffer (Ghost)'));
      body.append(this.mk('h5', 'Kanten'));
      body.append(this.lgLine('solid', '#5b6a99', 'gehört zu'));
      body.append(this.lgLine('dotted', '#6b7699', 'gleicher Tag'));
      body.append(this.lgLine('dashed', '#2dd4bf', 'semantisch ähnlich (Qdrant)'));
    }
  }

  // -------------------------------------------------------------------------
  // Entzerren (Rechtsklick)
  // -------------------------------------------------------------------------
  private nodeRadius(n: NodeSingular): number {
    const labelW = String(n.data('label') ?? '').length * 6;
    return Math.max(n.width(), labelW) / 2 + 14;
  }

  private resolveOverlaps(iterations = 30): void {
    const items = this.cy.nodes().map((n) => ({ n, p: { ...n.position() }, r: this.nodeRadius(n) }));
    if (!items.length) return;
    const cell = 2 * Math.max(...items.map((i) => i.r));
    for (let it = 0; it < iterations; it++) {
      let moved = false;
      const grid = new Map<string, typeof items>();
      for (const a of items) {
        const k = `${Math.floor(a.p.x / cell)}:${Math.floor(a.p.y / cell)}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k)!.push(a);
      }
      for (const a of items) {
        const gx = Math.floor(a.p.x / cell);
        const gy = Math.floor(a.p.y / cell);
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const bucket = grid.get(`${gx + ox}:${gy + oy}`);
            if (!bucket) continue;
            for (const b of bucket) {
              if (a === b) continue;
              const dx = b.p.x - a.p.x;
              const dy = b.p.y - a.p.y;
              const dist = Math.hypot(dx, dy) || 0.01;
              const min = a.r + b.r;
              if (dist < min) {
                const push = (min - dist) / 2;
                const ux = dx / dist;
                const uy = dy / dist;
                a.p.x -= ux * push;
                a.p.y -= uy * push;
                b.p.x += ux * push;
                b.p.y += uy * push;
                moved = true;
              }
            }
          }
        }
      }
      if (!moved) break;
    }
    for (const { n, p } of items) n.position(p);
  }

  private untangleAll(): void {
    this.elStatus.textContent = 'entzerre Layout …';
    const nodes = this.cy.nodes();
    if (!nodes.length) return;
    let cx = 0;
    let cyy = 0;
    nodes.forEach((n) => {
      const p = n.position();
      cx += p.x;
      cyy += p.y;
    });
    cx /= nodes.length;
    cyy /= nodes.length;
    nodes.positions((n) => {
      const p = n.position();
      return { x: cx + (p.x - cx) * 1.7, y: cyy + (p.y - cyy) * 1.7 };
    });
    this.resolveOverlaps(30);
    this.cy.fit(undefined, 40);
    this.elStatus.textContent = 'Layout entzerrt — nochmal Rechtsklick für mehr Abstand';
  }

  private untangleNode(node: NodeSingular): void {
    const neigh = node.neighborhood('node');
    const n = neigh.length;
    if (!n) return;
    const p = node.position();
    const radius = Math.max(120, (n * 48) / (2 * Math.PI));
    neigh.forEach((m, i) => {
      const a = (i / n) * 2 * Math.PI;
      (m as NodeSingular).animate(
        { position: { x: p.x + radius * Math.cos(a), y: p.y + radius * Math.sin(a) } },
        { duration: 300 },
      );
    });
    this.cy.animate({ fit: { eles: node.union(neigh), padding: 60 } }, { duration: 300 });
  }

  // -------------------------------------------------------------------------
  // Graph-Aufbau
  // -------------------------------------------------------------------------
  private overviewElements(data: api.OverviewResponse): any[] {
    const expanded = this.state.coreExpanded;
    const els: any[] = [{ data: {
      id: '__synapse__',
      label: expanded ? 'SYNAPSE — Weißes Loch' : 'SYNAPSE — Schwarzes Loch (Klick öffnet)',
      type: 'center',
      hole: expanded ? 'white' : 'black',
      color: expanded ? '#f2f6ff' : '#05060d',
      size: expanded ? 64 : 88,
    } }];
    if (!expanded) return els;
    for (const p of data.projekte) {
      els.push({ data: {
        id: p.name, label: p.name, type: 'project',
        color: p.running ? '#3ddc84' : p.enabled ? '#5b8cff' : '#8d99c4',
        running: !!p.running, enabled: !!p.enabled,
        size: sizeFor(p.files ?? 1, 18, 56),
      } });
      els.push({ data: { id: `e:${p.name}`, source: '__synapse__', target: p.name } });
    }
    return els;
  }

  private spiralPolar(i: number) {
    return { r: 150 + 30 * Math.sqrt(i + 1) * 1.5, a: i * 2.39996 };
  }
  private spiralPos(i: number) {
    const p = this.spiralPolar(i);
    return { x: Math.cos(p.a) * p.r, y: Math.sin(p.a) * p.r };
  }

  private renderOverview(els: any[]): void {
    const center = els.find((e) => e.data.id === '__synapse__');
    const projects = els.filter((e) => e.data.type === 'project');
    const edges = els.filter((e) => e.data.source);
    if (center) this.cy.add({ ...center, position: { x: 0, y: 0 } });
    const orbits = new Map<string, { r: number; a: number; w: number }>();
    projects.forEach((e, i) => {
      this.cy.add({ ...e, position: this.spiralPos(i) });
      const polar = this.spiralPolar(i);
      orbits.set(e.data.id, { r: polar.r, a: polar.a, w: 0.1 * Math.sqrt(150 / polar.r) });
    });
    this.cosmos.setOrbits(orbits);
    this.cy.add(edges);
    this.cy.fit(undefined, 70);
    if (this.state.coreJustExpanded) {
      this.state.coreJustExpanded = false;
      this.cosmos.pauseMotion(800);
      projects.forEach((e, i) => {
        const n = this.cy.getElementById(e.data.id);
        n.position({ x: 0, y: 0 });
        n.animate({ position: this.spiralPos(i) }, { duration: 650, easing: 'ease-out-cubic' });
      });
    }
  }

  private graphElements(data: api.CodeResponse, showExternals: boolean): any[] {
    const els: any[] = [];
    for (const n of data.nodes) {
      if (n.type === 'external' && !showExternals) continue;
      if (n.type === 'symbol') {
        els.push({ data: {
          id: n.id, label: n.label, type: 'symbol', file: n.file,
          color: SYM_COLORS[n.symbolType ?? ''] ?? '#90a4ae', size: 11,
        } });
        continue;
      }
      els.push({ data: {
        id: n.id, label: n.label, type: n.type, ext: n.ext,
        color: n.type === 'external' ? '#5c6685' : colorFor(n.ext ?? ''),
        size: n.type === 'external' ? 16 : sizeFor(n.fnCount ?? 0, 12, 44),
      } });
    }
    const ids = new Set(els.map((e) => e.data.id));
    for (const e of data.edges) {
      if (!ids.has(e.source) || !ids.has(e.target)) continue;
      els.push({ data: { id: `${e.source}→${e.target}`, source: e.source, target: e.target, type: e.type } });
    }
    return els;
  }

  private knowledgeElements(data: api.KnowledgeResponse): any[] {
    const els: any[] = [];
    for (const n of data.nodes) {
      const base = KIND_BASE[n.kind] ?? { color: '#90a4ae', size: 18 };
      let color = base.color;
      if (n.kind === 'task') color = TASK_COLORS[n.status ?? ''] ?? base.color;
      if (n.kind === 'memory') color = MEM_COLORS[n.category ?? ''] ?? base.color;
      els.push({ data: { ...n, color, size: base.size } });
    }
    const ids = new Set(els.map((e) => e.data.id));
    for (const e of data.edges) {
      if (!ids.has(e.source) || !ids.has(e.target)) continue;
      els.push({ data: { id: `${e.source}→${e.target}`, source: e.source, target: e.target, type: e.type } });
    }
    return els;
  }

  private render(els: any[]): void {
    this.cy.elements().remove();
    if (this.state.mode === 'overview') {
      this.renderOverview(els);
      return;
    }
    this.cy.add(els);
    this.cy.layout({ name: 'cose', animate: false, padding: 40, nodeRepulsion: () => 8000 } as any).run();
  }

  private renderSidebar(data: api.OverviewResponse): void {
    const box = this.elProjects;
    box.replaceChildren();
    for (const p of data.projekte) {
      const div = this.mk('div', null, 'sg-proj' + (this.state.project === p.name ? ' active' : ''));
      const dot = this.mk('span', null, 'sg-dot' + (p.running ? ' on' : ''));
      const name = this.mk('span', p.name);
      const meta = this.mk('span', [
        p.files != null ? `${p.files}f` : null,
        p.vectors != null ? `${p.vectors}v` : null,
      ].filter(Boolean).join(' '), 'sg-meta');
      div.append(dot, name, meta);
      div.addEventListener('click', () => this.enterProject(p.name));
      box.appendChild(div);
    }
  }

  // -------------------------------------------------------------------------
  // Refresh / Polling
  // -------------------------------------------------------------------------
  private async refresh(force = false): Promise<void> {
    if (this.destroyed) return;
    try {
      const overview = await api.fetchOverview();
      this.renderSidebar(overview);
      let els: any[] | null = null;
      let countsText = '';
      if (this.state.mode === 'overview') {
        els = this.overviewElements(overview);
        this.cosmos.syncUniverses(overview.projekte);
        countsText = `${overview.projekte.length} Projekte · Quelle: ${overview.quelle}`;
      } else if (!this.state.project) {
        return;
      } else if (this.state.view === 'code') {
        // GRAPH-1: Symbol-Ebenen werden inline via ?symbols=csv geliefert (kein separater Endpunkt mehr).
        const g = await api.fetchCode(this.state.project, this.symLayers());
        els = this.graphElements(g, this.elExternals.checked);
        const symCount = g.nodes.filter((n) => n.type === 'symbol').length;
        countsText = `${g.counts.files} Dateien · ${g.counts.internalEdges} interne Kanten · ${g.counts.externals} ext. Pakete`;
        if (symCount) countsText += ` · ${symCount} Symbole`;
      } else if (this.state.view === 'timeline') {
        const t = await api.fetchTimeline(this.state.project);
        this.renderTimeline(t.items ?? []);
        countsText = `${(t.items ?? []).length} Ereignisse · Dateien, Gedanken, Tasks, Memories, Proposals`;
      } else {
        const g = await api.fetchKnowledge(this.state.project, this.knowLayers());
        els = this.knowledgeElements(g);
        const c = g.counts;
        countsText = `${c.tasks}/${c.tasksTotal} Tasks · ${c.memories} Memories · ${c.thoughts} Thoughts · ${c.proposals} Proposals · ${c.tags} Tags`;
      }
      if (els) {
        const hash = this.state.view + JSON.stringify(els.map((e) => e.data.id).sort())
          + this.elExternals.checked + this.symLayers().join(',');
        if (force || hash !== this.state.lastHash) {
          this.state.lastHash = hash;
          this.render(els);
        }
      }
      if (this.state.mode === 'project') this.buildLegend(this.state.view);
      this.elCounts.textContent = countsText;
      this.elStatus.textContent = `aktualisiert ${new Date().toLocaleTimeString('de-DE')}`;
      this.elLive.style.color = '#3ddc84';
    } catch (err) {
      this.elStatus.textContent = `Fehler: ${(err as Error).message}`;
      this.elLive.style.color = '#ff5252';
    }
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------
  private setView(view: View): void {
    this.state.view = view;
    this.state.lastHash = '';
    this.clearDetails();
    this.elTabCode.classList.toggle('active', view === 'code');
    this.elTabKnow.classList.toggle('active', view === 'knowledge');
    this.elTabTime.classList.toggle('active', view === 'timeline');
    this.elLayersCode.style.display = view === 'code' ? 'flex' : 'none';
    this.elLayersKnow.style.display = view === 'knowledge' ? 'flex' : 'none';
    this.elLayersUniverse.style.display = 'none';
    this.elTimeline.style.display = view === 'timeline' ? 'block' : 'none';
    this.buildLegend(view);
    const crumbs: Record<View, string> = {
      code: `Projekt: ${this.state.project} — Code-Graph (Klick auf Datei = Details)`,
      knowledge: `Projekt: ${this.state.project} — Wissens-Graph: Plan, Tasks, Memories, Thoughts, Proposals`,
      timeline: `Projekt: ${this.state.project} — Chronik: alle Ereignisse chronologisch (Klick = Details)`,
    };
    this.elBreadcrumb.textContent = crumbs[view] ?? '';
    this.refresh(true);
  }

  private enterProject(name: string): void {
    this.state.mode = 'project';
    this.state.project = name;
    this.state.lastHash = '';
    this.clearDetails();
    this.elBack.style.display = 'inline-block';
    this.elTabs.style.display = 'flex';
    this.setView(this.state.view ?? 'code');
  }

  private goOverview(): void {
    this.state.mode = 'overview';
    this.state.lastHash = '';
    this.clearDetails();
    this.elBack.style.display = 'none';
    this.elTabs.style.display = 'none';
    this.elLayersCode.style.display = 'none';
    this.elLayersKnow.style.display = 'none';
    this.elLayersUniverse.style.display = 'flex';
    this.elTimeline.style.display = 'none';
    this.buildLegend('overview');
    this.elBreadcrumb.textContent = 'Übersicht aller Projekte';
    this.refresh(true);
  }
}
