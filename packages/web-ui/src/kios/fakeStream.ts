/**
 * Baut bereits fertiges HTML schrittweise als gültigen DOM-Baum auf.
 * Dadurch entstehen beim Streaming niemals halbfertige Tags oder flackerndes CSS.
 */
interface OpenStep {
  kind: 'open';
  source: Element;
  parentIndex: number;
  selfIndex: number;
  deep: boolean;
}

interface TextStep {
  kind: 'text';
  parentIndex: number;
  chunk: string;
}

type StreamStep = OpenStep | TextStep;

const ATOMIC_TAGS = new Set(['STYLE', 'TITLE']);
const TEXT_CHUNK_SIZE = 3;

function buildStreamSteps(root: DocumentFragment): StreamStep[] {
  const steps: StreamStep[] = [];
  let nodeIndex = 0;

  const visit = (parent: Node, parentIndex: number): void => {
    parent.childNodes.forEach((child) => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const element = child as Element;
        const selfIndex = ++nodeIndex;
        const deep = ATOMIC_TAGS.has(element.tagName.toUpperCase());
        steps.push({ kind: 'open', source: element, parentIndex, selfIndex, deep });
        if (!deep) visit(element, selfIndex);
        return;
      }

      if (child.nodeType !== Node.TEXT_NODE) return;
      const text = child.textContent ?? '';
      if (!text.trim() && text.length < 2) return;
      for (let offset = 0; offset < text.length; offset += TEXT_CHUNK_SIZE) {
        steps.push({ kind: 'text', parentIndex, chunk: text.slice(offset, offset + TEXT_CHUNK_SIZE) });
      }
    });
  };

  visit(root, 0);
  return steps;
}

export interface HtmlStreamHandle {
  cancel: () => void;
}

export function streamAgentHtml(
  target: Element,
  html: string,
  options: { speedFactor?: number; onDone?: () => void } = {},
): HtmlStreamHandle {
  target.replaceChildren();
  const template = document.createElement('template');
  template.innerHTML = html;

  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  if (reducedMotion) {
    target.appendChild(template.content.cloneNode(true));
    options.onDone?.();
    return { cancel: () => undefined };
  }

  const steps = buildStreamSteps(template.content);
  const nodes: Node[] = [target];
  const duration = Math.min(6500, Math.max(900, html.length * 2.1)) * (options.speedFactor ?? 1);
  const tickMilliseconds = 16;
  const stepsPerTick = Math.max(1, Math.ceil(steps.length / Math.max(1, duration / tickMilliseconds)));
  let stepIndex = 0;

  const applyStep = (step: StreamStep): void => {
    if (step.kind === 'open') {
      const clone = step.source.cloneNode(step.deep) as Element;
      nodes[step.parentIndex]?.appendChild(clone);
      nodes[step.selfIndex] = clone;
      return;
    }

    const parent = nodes[step.parentIndex];
    if (!parent) return;
    const lastChild = parent.lastChild;
    if (lastChild?.nodeType === Node.TEXT_NODE) (lastChild as Text).data += step.chunk;
    else parent.appendChild(document.createTextNode(step.chunk));
  };

  const timer = window.setInterval(() => {
    for (let count = 0; count < stepsPerTick && stepIndex < steps.length; count += 1, stepIndex += 1) {
      applyStep(steps[stepIndex]);
    }
    if (stepIndex >= steps.length) {
      window.clearInterval(timer);
      options.onDone?.();
    }
  }, tickMilliseconds);

  return { cancel: () => window.clearInterval(timer) };
}
