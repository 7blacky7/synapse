/** P22-T195: globaler Entwurf pro User-Sitzung; vorhandener Logout-Praefix aus T168. Persistierte PG-Anmerkungen bleiben erhalten. */
import type {AnmerkungEntwurf} from '../api/quellenanmerkungen';
export const ANMERKUNG_KORB_KEY='synapse:zitat-entwurf:quellenanmerkungen';
let stand:{vorgang:string;eintraege:AnmerkungEntwurf[];fehler:string|null}|null=null;
const hoerer=new Set<()=>void>();
/** UUIDv4 auch im HTTP-LAN: randomUUID ist dort nicht verfügbar, getRandomValues schon. */
export function neueAnmerkungId():string{
 if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
 const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
 const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
 return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
}

function initial(){try{const x=JSON.parse(localStorage.getItem(ANMERKUNG_KORB_KEY)??'null');if(x&&typeof x.vorgang==='string'&&Array.isArray(x.eintraege))return {...x,fehler:null} as NonNullable<typeof stand>;}catch{/* leer */}return {vorgang:neueAnmerkungId(),eintraege:[] as AnmerkungEntwurf[],fehler:null};}
export function leseAnmerkungKorb(){return stand??(stand=initial());}
export function abonniereAnmerkungKorb(f:()=>void){hoerer.add(f);return()=>{hoerer.delete(f);};}
export function merkeAnmerkungKorb(eintraege:AnmerkungEntwurf[],neuerVorgang=false){stand={...leseAnmerkungKorb(),eintraege,fehler:null,...neuerVorgang?{vorgang:neueAnmerkungId()}:{}};try{localStorage.setItem(ANMERKUNG_KORB_KEY,JSON.stringify(stand));}catch{stand={...stand,fehler:'Entwurf konnte nicht dauerhaft im Browser gespeichert werden. Bitte diesen Tab offen halten.'};}for(const f of hoerer)f();}
export function leereAnmerkungKorb(){stand={vorgang:neueAnmerkungId(),eintraege:[],fehler:null};try{localStorage.removeItem(ANMERKUNG_KORB_KEY);}catch{/* leer */}for(const f of hoerer)f();}
