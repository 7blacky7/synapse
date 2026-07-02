/**
 * KIOS-1: Fake-Streaming — fertiges HTML wird progressiv "aufgetippt".
 *
 * Kein echtes HTML-Streaming (halbfertige Tags = kaputtes DOM). Stattdessen:
 * das fertige, sanitized HTML wird in einen Template-Baum geparst und dann
 * DOM-Knoten fuer DOM-Knoten in den Zielcontainer uebertragen — Elemente in
 * Dokumentreihenfolge, Textknoten in kleinen Zeichen-Chunks. <style>-Elemente
 * werden atomar (deep clone) eingefuegt, damit kein halbfertiges CSS flackert.
 *
 * Die Dauer skaliert mit der HTML-Groesse (Vision: natuerlicher Zeitpuffer
 * fuer die naechste KI-Iteration). prefers-reduced-motion => sofort komplett.
 */

interface OpenStep { kind: 'open'; src: Element; parentIdx: number; selfIdx: number; deep: boolean; }
interface TextStep { kind: 'text'; parentIdx: number; chunk: string; }
type Step = OpenStep | TextStep;

const ATOMIC_TAGS = new Set(['STYLE', 'TITLE']);
const CHUNK = 3;

function buildSteps(root: DocumentFragment): { steps: Step[]; count: number } {
  const steps: Step[] = [];
  let counter = 0;
  const walk = (parent: Node, parentIdx: number): void => {
    parent.childNodes.forEach((c) => {
      if (c.nodeType === Node.ELEMENT_NODE) {
        const el = c as Element;
        const selfIdx = ++counter;
        const atomic = ATOMIC_TAGS.has(el.tagName.toUpperCase());
        steps.push({ kind: 'open', src: el, parentIdx, selfIdx, deep: atomic });
        if (!atomic) walk(el, selfIdx);
      } else if (c.nodeType === Node.TEXT_NODE) {
        const txt = c.textContent ?? '';
        if (!txt.trim() && txt.length < 2) return;
        for (let i = 0; i < txt.length; i += CHUNK) {
          steps.push({ kind: 'text', parentIdx, chunk: txt.slice(i, i + CHUNK) });
        }
      }
    });
  };
  walk(root, 0);
  return { steps, count: counter };
}

export interface StreamHandle { cancel: () => void; }

export function streamHtml(
  target: Element,
  html: string,
  opts: { speedFactor?: number; onDone?: () => void } = {},
): StreamHandle {
  target.replaceChildren();
  const tpl = document.createElement('template');
  tpl.innerHTML = html;

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  if (reduced) {
    target.appendChild(tpl.content.cloneNode(true));
    opts.onDone?.();
    return { cancel: () => undefined };
  }

  const { steps } = buildSteps(tpl.content);
  const nodes: Node[] = [target];
  const duration = Math.min(6500, Math.max(1100, html.length * 2.4)) * (opts.speedFactor ?? 1);
  const tickMs = 16;
  const perTick = Math.max(1, Math.ceil(steps.length / Math.max(1, duration / tickMs)));

  let i = 0;
  const apply = (s: Step): void => {
    if (s.kind === 'open') {
      const clone = s.src.cloneNode(s.deep) as Element;
      nodes[s.parentIdx].appendChild(clone);
      nodes[s.selfIdx] = clone;
    } else {
      const p = nodes[s.parentIdx];
      if (!p) return;
      const last = p.lastChild;
      if (last && last.nodeType === Node.TEXT_NODE) (last as Text).data += s.chunk;
      else p.appendChild(document.createTextNode(s.chunk));
    }
  };

  const timer = window.setInterval(() => {
    for (let k = 0; k < perTick && i < steps.length; k++, i++) apply(steps[i]);
    if (i >= steps.length) {
      window.clearInterval(timer);
      opts.onDone?.();
    }
  }, tickMs);

  return {
    cancel: () => {
      window.clearInterval(timer);
    },
  };
}
