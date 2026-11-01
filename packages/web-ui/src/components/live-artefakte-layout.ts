/** P22-T164: relative horizontale Koordinaten, vertikale Pixel; reine Bewegung für Maus und Tastatur. */
export interface Lage { x:number; y:number; breite:number; hoehe:number; revision:number }
export function verschiebe(v:Lage,dx:number,dy:number):Lage {
  return {...v,x:Math.max(0,Math.min(100-v.breite,v.x+dx)),y:Math.max(0,v.y+dy)};
}
export function skaliere(v:Lage,dw:number,dh:number):Lage {
  return {...v,breite:Math.max(10,Math.min(100-v.x,v.breite+dw)),hoehe:Math.max(100,v.hoehe+dh)};
}
/** P22-T259: Anzeige des Titels - HTML-Entitaeten aus gespeicherten Titeln (z. B. '&amp;') werden als Zeichen gezeigt; leer = 'Artefakt'. Nur Anzeige, Daten bleiben. */
export function anzeigeTitel(t:string|null|undefined):string {
  const s=(t ?? '').replace(/&(amp|lt|gt|quot|#39|apos);/g,(_,n:string)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'",apos:"'"} as Record<string,string>)[n]).trim();
  return s || 'Artefakt';
}
/** P22-T259: kurze ID im Kachelkopf (die volle ID steht im Tooltip). */
export const kurzeId=(id:string)=>id.length>8 ? id.slice(0,8) : id;

/** P22-T259 L3/L4: Auf der Leinwand liegt nur, was der User hinzugefuegt hat (Feld auf_leinwand der Layout-Zeile; null = nie). */
export const aufLeinwand=(e:{auf_leinwand?:boolean|null})=>e.auf_leinwand===true;
/** P22-T259 L3: Lage fuer ein neu hinzugefuegtes Artefakt - links unter der untersten Kachel (Unterkanten inkl. Abstand), die
 *  gespeicherte Groesse bleibt, sonst 48 % x 320 px wie bisher. */
export function freieLage(unterkanten:number[],groesse:{breite?:number|null;hoehe?:number|null}={}):Omit<Lage,'revision'> {
  const breite=Math.max(10,Math.min(100,groesse.breite ?? 48)), hoehe=Math.max(100,groesse.hoehe ?? 320);
  return {x:0,y:Math.max(0,...unterkanten.filter(Number.isFinite)),breite,hoehe};
}
