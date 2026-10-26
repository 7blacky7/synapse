/**
 * P22-T191: Katalog und Namensaufloesung. PG liefert aktuelle Rechte/Metadaten; der bestehende Code-Index die Semantik.
 * Interne Index-Namespaces sind KEINE registrierten Projekte: kein Host-Binding, keine Datei-Synchronisation.
 */
import { createHash } from 'node:crypto';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { internToolAktiv } from './intern-tool-aktiv.js';
import { indexiereDateiInhalt, parseAndEmbed, searchCode } from './code.js';
import type { ArtefaktBetrachter } from './artefakt-vorlagen.js';

export type ArtefaktDateiZugang = ArtefaktBetrachter & { session_id?: string | null };
export class ArtefaktDateiFehler extends Error {
  constructor(public code: string, message: string, public treffer?: unknown[]) { super(message); }
}
export const artefaktText = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
export const artefaktUuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export async function artefaktDateiSchalter(funktion: 'artefakt_dateien' | 'tool_antwort_ueberlauf' = 'artefakt_dateien', project?: string | null) {
  const p = await leseProfilProduktSchalter(funktion, project).catch(() => null);
  const basis = { name: funktion, aktiv: !!p && p.aktiv && !p.letzter_fehler, quelle: p?.quelle ?? 'fehler',
    letzter_fehler: p?.letzter_fehler ?? (p ? null : 'nicht_lesbar'), bis: null as string | null, intern_fehler: null as string | null };
  if (!internToolAktiv()) return basis;
  try {
    const r = await getPool().query<{ aktiv: boolean; bis: Date|null }>({ text: "SELECT aktiv,bis FROM intern_schalter WHERE name=$1 AND modus='freigegeben' AND (bis IS NULL OR bis>NOW())", values: [funktion], query_timeout: 2000 } as import('pg').QueryConfig & {query_timeout:number});
    const z = r.rows[0];
    return z ? { ...basis, aktiv: z.aktiv, quelle: 'intern', letzter_fehler: null, bis: z.bis?.toISOString()??null } : basis;
  } catch { return { ...basis, intern_fehler: 'intern_nicht_lesbar' }; }
}
export async function pruefeArtefaktDateiFreigabe(project?: string | null) {
  const s = await artefaktDateiSchalter('artefakt_dateien', project);
  if (!s.aktiv) throw new ArtefaktDateiFehler('funktion_aus', 'Artefakt-Dateien sind aus (artefakt_dateien); Quelle: '+s.quelle);
  return s;
}
export interface ArtefaktKatalogEintrag {
  artefakt_id: string; name: string | null; titel: string | null; beschreibung: string | null;
  bereich: 'global' | 'projekt'; project: string | null; revision: number; updated_at: Date;
  created_by_identity_id: string | null; session_id: string | null; ueberlauf: boolean; ablauf_am: Date | null;
}
const AUSWAHL = `SELECT a.id::text AS artefakt_id,a.name,a.title AS titel,a.beschreibung,
 COALESCE(a.bereich,CASE WHEN a.vorlage IS NOT NULL THEN 'global' ELSE 'projekt' END) AS bereich,
 COALESCE(a.standard_project,i.project) AS project,a.revision,a.updated_at,a.created_by_identity_id::text,a.session_id::text,
 a.ueberlauf,a.ablauf_am FROM agent_artifacts a LEFT JOIN agent_identitaeten i ON i.id=a.created_by_identity_id`;
export function darfArtefaktLesen(z: ArtefaktKatalogEintrag, b: ArtefaktDateiZugang): boolean {
  if (z.ablauf_am && new Date(z.ablauf_am).getTime() <= Date.now()) return false;
  return b.art === 'user' || b.main || z.bereich === 'global' || (!!b.session_id && b.session_id===z.session_id)
    || (!!b.identity_id && b.identity_id===z.created_by_identity_id) || (!!z.project && b.project===z.project);
}
export function darfArtefaktSchreiben(z: ArtefaktKatalogEintrag, b: ArtefaktDateiZugang): boolean {
  return (!!b.session_id && b.session_id===z.session_id) || (b.art==='agent' && !!b.identity_id && b.identity_id===z.created_by_identity_id);
}
export function artefaktIndexProjekt(project: string | null): string {
  return project ? '__artefakte_'+createHash('sha256').update(project).digest('hex').slice(0,24) : '__artefakte_global__';
}
export const artefaktKatalogPfad = (id: string) => 'artefakte/'+id+'/katalog.md';
export async function ladeArtefaktKatalogEintrag(id: string, b: ArtefaktDateiZugang): Promise<ArtefaktKatalogEintrag> {
  if (!artefaktUuid(id)) throw new ArtefaktDateiFehler('artefakt_id_ungueltig', 'UUID oder eindeutigen Namen angeben');
  const z = (await getPool().query<ArtefaktKatalogEintrag>(AUSWAHL+' WHERE a.id=$1::uuid',[id])).rows[0];
  if (!z || !darfArtefaktLesen(z,b)) throw new ArtefaktDateiFehler('artefakt_unbekannt', 'Artefakt nicht gefunden oder nicht lesbar');
  return z;
}
export async function indexiereArtefaktKatalog(z: ArtefaktKatalogEintrag): Promise<void> {
  const project = artefaktIndexProjekt(z.bereich==='global' ? null : z.project)+'_katalog';
  const path = artefaktKatalogPfad(z.artefakt_id);
  const content = ['# '+(z.name??z.titel??z.artefakt_id),z.titel??'',z.beschreibung??''].join('\n');
  await indexiereDateiInhalt(path,project,content);
  await parseAndEmbed(project,path);
}
export async function listeArtefaktKatalog(args: Record<string, unknown>, b: ArtefaktDateiZugang) {
  const project = artefaktText(args.project) || (b.art==='agent' ? b.project : '');
  if (b.art==='agent' && !b.main && project && project!==b.project) throw new ArtefaktDateiFehler('projekt_fremd','Nur eigenes Projekt und globale Artefakte');
  const limit = args.limit===undefined ? 50 : Number(args.limit), offset = args.offset===undefined ? 0 : Number(args.offset);
  if (!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(offset)||offset<0) throw new ArtefaktDateiFehler('bereich_ungueltig','limit 1..200, offset ab 0');
  const scope = args.scope??'all';
  if (!['project','global','all'].includes(String(scope))) throw new ArtefaktDateiFehler('scope_ungueltig','scope project|global|all');
  const query = artefaktText(args.query)||artefaktText(args.name);
  // SQL filtert vor LIMIT; fremde Projekte koennen weder Treffer noch Mehrdeutigkeit erzeugen.
  const r = await getPool().query<ArtefaktKatalogEintrag>(AUSWAHL+`
    WHERE (a.ablauf_am IS NULL OR a.ablauf_am>NOW()) AND
    ($1::boolean OR COALESCE(a.bereich,CASE WHEN a.vorlage IS NOT NULL THEN 'global' ELSE 'projekt' END)='global'
     OR COALESCE(a.standard_project,i.project)=$2 OR a.created_by_identity_id::text=$3 OR a.session_id::text=$4)
    AND ($5='all' OR ($5='global' AND COALESCE(a.bereich,CASE WHEN a.vorlage IS NOT NULL THEN 'global' ELSE 'projekt' END)='global')
      OR ($5='project' AND COALESCE(a.bereich,CASE WHEN a.vorlage IS NOT NULL THEN 'global' ELSE 'projekt' END)='projekt' AND COALESCE(a.standard_project,i.project)=$2))
    AND ($6='' OR $7::boolean OR CASE WHEN $8::boolean THEN lower(COALESCE(a.name,''))=lower($6) OR lower(COALESCE(a.title,''))=lower($6)
      ELSE position(lower($6) IN lower(COALESCE(a.name,'')||' '||COALESCE(a.title,'')||' '||COALESCE(a.beschreibung,'')))>0 END)
    ORDER BY a.updated_at DESC,a.id LIMIT $9 OFFSET $10`,
    [b.art==='user'||b.main,project,b.art==='agent'?b.identity_id:null,b.session_id??null,String(scope),query,args.semantic===true,args.exact===true,args.semantic===true?null:limit+1,args.semantic===true?0:offset]);
  let rows=r.rows.filter(z=>darfArtefaktLesen(z,b));
  const warnings:string[]=[];
  if (args.semantic===true && query) {
    // EINE Semantikquelle: bestehender Code-Index fuer Katalogtexte, keine zweite Vektortabelle.
    const namespaces=[...new Set(rows.map(z=>artefaktIndexProjekt(z.bereich==='global'?null:z.project)+'_katalog'))];
    for (const z of rows) await indexiereArtefaktKatalog(z).catch(()=>warnings.push('index_nachzug:'+z.artefakt_id));
    const score=new Map<string,number>();
    for (const p of namespaces) {
      try { for (const h of await searchCode(query,p,'md',rows.length+1)) {
        const id=String(h.payload?.file_path??'').match(/^artefakte\/([a-f0-9-]+)\/katalog\.md$/)?.[1];
        if(id)score.set(id,Math.max(score.get(id)??-Infinity,h.score));
      } } catch { warnings.push('semantik_nicht_erreichbar:'+p); }
    }
    rows=rows.filter(z=>score.has(z.artefakt_id)).sort((a,b)=>(score.get(b.artefakt_id)??0)-(score.get(a.artefakt_id)??0));
  }
  if (args.semantic===true) rows=rows.slice(offset);
  const mehr=rows.length>limit;
  return { success:!warnings.some(w=>w.startsWith('semantik_nicht_erreichbar')), ...(warnings.some(w=>w.startsWith('semantik_nicht_erreichbar'))?{error:'semantik_nicht_erreichbar',unvollstaendig:true}:{}), artefakte:rows.slice(0,limit), count:Math.min(rows.length,limit), mehr, naechster_offset:mehr?offset+limit:null,
    debug:{modus:args.semantic===true?'semantisch':args.exact===true?'exakt':'teiltext',quelle:'postgresql+code_index',warnings} };
}
export async function loeseArtefaktName(ref: string, b: ArtefaktDateiZugang): Promise<ArtefaktKatalogEintrag> {
  if(artefaktUuid(ref))return ladeArtefaktKatalogEintrag(ref,b);
  if(!ref.trim())throw new ArtefaktDateiFehler('artefakt_id_fehlt','artefakt_id oder name angeben');
  const r=await listeArtefaktKatalog({query:ref,exact:true,limit:200},b);
  if(r.artefakte.length!==1||r.mehr)throw new ArtefaktDateiFehler(r.artefakte.length?'artefakt_mehrdeutig':'artefakt_unbekannt',
    r.artefakte.length?'Name nicht eindeutig; artefakt_id aus Trefferliste verwenden':'Kein lesbares Artefakt mit diesem Namen',r.artefakte);
  return r.artefakte[0];
}
export async function setzeArtefaktMetadaten(id:string,args:Record<string,unknown>,b:ArtefaktDateiZugang) {
  const z=await ladeArtefaktKatalogEintrag(id,b);
  if(!darfArtefaktSchreiben(z,b))throw new ArtefaktDateiFehler('nicht_urheber','Metadaten aendert nur Urheber oder Main-Session');
  if(args.bereich!==undefined&&!['projekt','global'].includes(String(args.bereich)))throw new ArtefaktDateiFehler('bereich_ungueltig','bereich projekt|global');
  if (artefaktText(args.name).length>200 || artefaktText(args.beschreibung).length>4000) throw new ArtefaktDateiFehler('metadaten_zu_lang','Name max 200, Beschreibung max 4000 Zeichen');
  await getPool().query('UPDATE agent_artifacts SET name=COALESCE($2,name),beschreibung=COALESCE($3,beschreibung),bereich=COALESCE($4,bereich),updated_at=NOW() WHERE id=$1::uuid',
    [id,args.name===undefined?null:artefaktText(args.name),args.beschreibung===undefined?null:artefaktText(args.beschreibung),args.bereich??null]);
  const neu=await ladeArtefaktKatalogEintrag(id,b);
  // Ein Indexausfall macht einen bereits geschriebenen PG-Metadatenstand nicht zum scheinbaren Schreibfehler.
  const index_fehler = await indexiereArtefaktKatalog(neu).then(()=>null,()=> 'index_nachzug');
  return { ...neu, index_fehler };
}
