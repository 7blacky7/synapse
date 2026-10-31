/** P22-T164: relative horizontale Koordinaten, vertikale Pixel; reine Bewegung für Maus und Tastatur. */
export interface Lage { x:number; y:number; breite:number; hoehe:number; revision:number }
export function verschiebe(v:Lage,dx:number,dy:number):Lage {
  return {...v,x:Math.max(0,Math.min(100-v.breite,v.x+dx)),y:Math.max(0,v.y+dy)};
}
export function skaliere(v:Lage,dw:number,dh:number):Lage {
  return {...v,breite:Math.max(10,Math.min(100-v.x,v.breite+dw)),hoehe:Math.max(100,v.hoehe+dh)};
}
