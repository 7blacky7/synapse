/** P18-T72: Siedler 3 container extraction in E. Global library => global product switch, standard OFF.
 * Admin/Web-UI use the existing product-switch catalog; intern is only a temporary test override.
 */
import {getPool} from '../db/client.js';
import {leseProfilProduktSchalter} from './agent-profil-schalter.js';
import {internToolAktiv} from './intern-tool.js';

export async function leseReverseSiedler3Schalter(){
 const produkt=await leseProfilProduktSchalter('reverse_siedler3',null);
 let stand:{aktiv:boolean;quelle:'standard'|'produkt-schalter'|'intern';bis:string|null;letzter_fehler:string|null}
  ={aktiv:produkt.aktiv,quelle:produkt.quelle,bis:null,letzter_fehler:produkt.letzter_fehler};
 if(internToolAktiv()){
  try{
   const r=await getPool().query({text:"SELECT aktiv,bis FROM intern_schalter WHERE name='reverse_siedler3' AND modus='freigegeben' AND bis>NOW()",query_timeout:2000} as import('pg').QueryConfig & {query_timeout:number});
   const z=r.rows[0];
   if(z)stand={aktiv:z.aktiv,quelle:'intern',bis:new Date(z.bis).toISOString(),letzter_fehler:null};
  }catch{stand.letzter_fehler='reverse_siedler3_override_nicht_lesbar';}
 }
 return stand;
}
