/**
 * Bereinigt HTML-Antworten des Hauptagenten vor der Darstellung.
 * SVG, CSS, Formulare und Inline-Styles bleiben erlaubt; aktive Inhalte werden entfernt.
 */
const BLOCKED_TAGS = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE']);
const URL_ATTRIBUTES = ['href', 'src', 'xlink:href', 'action', 'formaction'];

function cleanElement(element: Element): void {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith('on')) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (URL_ATTRIBUTES.includes(name) && attribute.value.trim().toLowerCase().startsWith('javascript:')) {
      element.removeAttribute(attribute.name);
    }
  }
}

export function sanitizeAgentHtml(html: string): string {
  const documentNode = new DOMParser().parseFromString(html, 'text/html');
  const walker = documentNode.createTreeWalker(documentNode.body, NodeFilter.SHOW_ELEMENT);
  const blockedElements: Element[] = [];
  let node = walker.nextNode();

  while (node) {
    const element = node as Element;
    if (BLOCKED_TAGS.has(element.tagName.toUpperCase())) blockedElements.push(element);
    else cleanElement(element);
    node = walker.nextNode();
  }

  for (const element of blockedElements) element.remove();
  return documentNode.body.innerHTML;
}
