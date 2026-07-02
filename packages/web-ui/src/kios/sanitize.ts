/**
 * KIOS-1: HTML-Sanitizer fuer KI-Renderings.
 *
 * Regel aus der Vision: <script> raus, alles andere (SVG, CSS, Formulare,
 * Inline-Styles) erlaubt. Zusaetzlich raus: aktive Embeds (iframe/object/
 * embed), Dokument-Direktiven (link/meta/base), on*-Event-Attribute und
 * javascript:-URLs. Single-User hinter Auth — das hier ist Stabilitaets-,
 * kein Multi-Tenant-Schutz.
 */

const BLOCKED_TAGS = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE']);
const URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction'];

function cleanElement(el: Element): void {
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    if (name.startsWith('on')) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (URL_ATTRS.includes(name) && attr.value.trim().toLowerCase().startsWith('javascript:')) {
      el.removeAttribute(attr.name);
    }
  }
}

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  const toRemove: Element[] = [];
  let node = walker.nextNode();
  while (node) {
    const el = node as Element;
    if (BLOCKED_TAGS.has(el.tagName.toUpperCase())) toRemove.push(el);
    else cleanElement(el);
    node = walker.nextNode();
  }
  for (const el of toRemove) el.remove();
  return doc.body.innerHTML;
}
