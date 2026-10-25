/**
 * Bereinigt HTML-Antworten des Hauptagenten vor der Darstellung.
 * SVG, CSS, Formulare und Inline-Styles bleiben erlaubt; aktive Inhalte werden entfernt.
 *
 * P22-T167 (Sicherheit):
 * - URL-Attribute nur mit erlaubtem Schema (Erlaubnisliste statt Sperrliste). Vor der Pruefung werden Steuerzeichen
 *   und Whitespace entfernt, so wie es der URL-Parser des Browsers tut; Entities hat der HTML-Parser schon aufgeloest.
 * - SVG-Animationen (animate, set, animateMotion, animateTransform), die URL- oder Ereignis-Attribute aendern, entfallen.
 * - fakeStream parst das Ergebnis erneut per template.innerHTML (anderer Parser-Modus als DOMParser). Deshalb wird die
 *   Ausgabe zusaetzlich unter diesem Parser bereinigt, bis sie stabil ist; sonst wird der Inhalt nur als Text gezeigt.
 */
const BLOCKED_TAGS = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'NOSCRIPT', 'TEMPLATE', 'FRAME', 'FRAMESET']);
const URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'background', 'ping', 'srcset']);
const ERLAUBTE_SCHEMATA = new Set(['http', 'https', 'mailto', 'tel']);
/** Elemente, deren Quelle ein eingebettetes Bild (data:image) sein darf. */
const BILD_TAGS = new Set(['img', 'image', 'source', 'video', 'feimage', 'input']);
const DATA_BILD = /^data:image\/(png|gif|jpeg|webp)[;,]/;
const ANIMATIONEN = new Set(['animate', 'set', 'animatemotion', 'animatetransform']);
const STABIL_DURCHLAEUFE = 3;

/** Steuerzeichen und Whitespace entfernen (wie der URL-Parser des Browsers) und klein schreiben. Rein. */
export function normalisiereUrl(wert: string): string {
  return wert.replace(/[\u0000- \u007f]/g, '').toLowerCase();
}

/** true = ohne Schema (relativ, #, ?) oder erlaubtes Schema; data:image nur fuer Bildquellen. Rein. */
export function urlErlaubt(wert: string, bild = false): boolean {
  const n = normalisiereUrl(wert);
  const schema = /^([a-z][a-z0-9+.-]*):/.exec(n);
  if (!schema) return true;
  if (ERLAUBTE_SCHEMATA.has(schema[1])) return true;
  return bild && DATA_BILD.test(n);
}

/** srcset: jede Bildangabe pruefen (URL = erstes Wort je Eintrag). Rein. */
export function srcsetErlaubt(wert: string): boolean {
  return wert.split(',').every((eintrag) => {
    const url = eintrag.trim().split(/\s+/)[0] ?? '';
    return url === '' || urlErlaubt(url, true);
  });
}

/** true = SVG-Animation, die ein URL- oder Ereignis-Attribut veraendern wuerde. Rein. */
export function istUrlAnimation(tag: string, attributeName: string | null): boolean {
  if (!ANIMATIONEN.has(tag.toLowerCase())) return false;
  const ziel = normalisiereUrl(attributeName ?? '');
  return ziel === 'href' || ziel.endsWith(':href') || ziel.startsWith('on') || URL_ATTRIBUTES.has(ziel);
}

function cleanElement(element: Element): void {
  const tag = element.tagName.toLowerCase();
  const bild = BILD_TAGS.has(tag);
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith('on')) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (name === 'srcset') {
      if (!srcsetErlaubt(attribute.value)) element.removeAttribute(attribute.name);
      continue;
    }
    if ((URL_ATTRIBUTES.has(name) || name.endsWith(':href')) && !urlErlaubt(attribute.value, bild)) {
      element.removeAttribute(attribute.name);
    }
  }
}

function bereinige(wurzel: ParentNode): void {
  const entfernen: Element[] = [];
  for (const element of Array.from(wurzel.querySelectorAll('*'))) {
    if (BLOCKED_TAGS.has(element.tagName.toUpperCase()) || istUrlAnimation(element.tagName, element.getAttribute('attributeName') ?? element.getAttribute('attributename'))) {
      entfernen.push(element);
    } else {
      cleanElement(element);
    }
  }
  for (const element of entfernen) element.remove();
}

export function sanitizeAgentHtml(html: string): string {
  const documentNode = new DOMParser().parseFromString(html, 'text/html');
  bereinige(documentNode.body);
  let ausgabe = documentNode.body.innerHTML;
  // Gleicher Parser wie fakeStream (template.innerHTML): dort erneut bereinigen, bis die Ausgabe stabil ist.
  for (let durchlauf = 0; durchlauf < STABIL_DURCHLAEUFE; durchlauf++) {
    const vorlage = document.createElement('template');
    vorlage.innerHTML = ausgabe;
    bereinige(vorlage.content);
    const neu = vorlage.innerHTML;
    if (neu === ausgabe) return ausgabe;
    ausgabe = neu;
  }
  // Nicht stabil: lieber als Text zeigen als etwas Ungepruefendes rendern.
  const text = document.createElement('div');
  text.textContent = html;
  return text.innerHTML;
}
