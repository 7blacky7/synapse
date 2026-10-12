/**
 * MODUL: intern shell_altbestand_maskieren (P10-T42, 12.10.2026)
 * ZWECK: Alte Shell-Ausgaben (shell_jobs, Shell-tool_calls) mit DERSELBEN Live-Maske nachmaskieren,
 *        die jede neue Ausgabe beim Speichern bekommt (maskiereShellDaten, steuerdaten=true).
 *        Ziel des Users: keine API-Schluessel und Passwoerter mehr im Altbestand lesbar.
 *
 * ABLAUF:
 *   - Ohne ausfuehren:true = Vorschau: zaehlt je Tabelle, wie viele Zeilen und Werte sich aendern wuerden.
 *     Schreibt nichts.
 *   - ausfuehren:true (nur Koordinator/User): je Zeile EINE Transaktion mit lock_timeout und
 *     statement_timeout, FOR UPDATE, Neuberechnung aus dem gesperrten Stand, nur geaenderte Felder.
 *     Laufende Jobs (pending/running) bleiben unberuehrt. Ein zweiter Lauf aendert nichts mehr.
 *   - limit begrenzt die Zahl der geschriebenen Zeilen je Aufruf (Stapelweise ausfuehren).
 * NICHT UMKEHRBAR: maskierte Werte sind danach weg (wie bei neuen Ausgaben auch).
 */

import { getPool } from '../db/client.js';
import { ladeShellWerte, maskiereShellDaten, maskiereShellText } from './shell-maske.js';
import { sammleShellMaskenTreffer } from './shell-masken-katalog.js';
import { istShellGeheimnisName } from './mcp-json-maske.js';
import { darfKoordinatorOderUser } from './rollen-pruefung.js';

export const SHELL_ALT_ACTIONS = ['shell_altbestand_maskieren'] as const;
export type ShellAltAction = (typeof SHELL_ALT_ACTIONS)[number];

export function istShellAltAction(action: string): action is ShellAltAction {
  return (SHELL_ALT_ACTIONS as readonly string[]).includes(action);
}

export const SHELL_ALT_BESCHREIBUNG =
  'SHELL-ALTBESTAND: shell_altbestand_maskieren (project, ausfuehren, limit): alte shell_jobs- und Shell-tool_calls-Ausgaben mit ' +
  'derselben Live-Maske nachmaskieren wie neue beim Speichern; ohne ausfuehren:true nur Zaehlung, ausfuehren:true nur ' +
  'Koordinator/User, je Zeile Sperre und Neuberechnung, laufende Jobs bleiben, nicht umkehrbar. ';

/** Nur NEUE Parameter (project, ausfuehren und limit gibt es schon). */
export const SHELL_ALT_PARAMETER: Record<string, unknown> = {
  seit: {type:'string',description:'Nur Zeilen ab diesem ISO-Zeitpunkt (shell_jobs.created_at bzw. tool_calls.ts).'},
  diagnose: {type:'boolean',description:'Nur Vorschau: bis zu 100 geaenderte Felder mit ID, Regel, Name und Laenge; niemals Werte.'},
};

const FELDER = { shell_jobs: ['output', 'tail', 'message', 'error'], tool_calls: ['result', 'args_preview', 'error'] } as const;
type Tabelle = keyof typeof FELDER;
const SEITE = 500;

interface Zaehlung { geprueft: number; zu_aendern: number; laufend: number; geschrieben: number; werte: number; uebersprungen: number; fehler: number }

function idSpalte(t: Tabelle): string { return t === 'shell_jobs' ? 'id::text' : 'id'; }
function laufend(t: Tabelle, status: unknown): boolean { return t === 'shell_jobs' && (status === 'pending' || status === 'running'); }
function daten(t: Tabelle, r: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(FELDER[t].map((k) => [k, r[k]]));
}


interface MaskenDiagnose {
  tabelle:Tabelle; id:string; feld:string;
  ohne_wertliste:boolean;
  treffer:Array<{regel:string;name?:string;laenge:number}>;
  treffer_gekappt:boolean;
}
/** Nur Klassifikation: keine Ausschnitte, Werte oder Wert-Hashes verlassen diesen Weg. */
function diagnoseFeld(alt:unknown,neu:unknown,werte:readonly string[]):MaskenDiagnose['treffer'] {
  const treffer:MaskenDiagnose['treffer']=[];
  const walk=(a:unknown,b:unknown,name?:string):void=>{
    if(JSON.stringify(a)===JSON.stringify(b))return;
    if(typeof a==='string'){
      if(typeof b==='string')try {const x=JSON.parse(a),y=JSON.parse(b);walk(x,y,name);return;}catch {/* freier Text */}
      const hits=sammleShellMaskenTreffer(a,werte,name?{name,strukturiert:true}:{});
      for(const h of hits)treffer.push({
        regel:h.regel,
        ...(h.name?{name:maskiereShellText(h.name,werte).text}:{}),
        laenge:h.ende-h.start,
      });
      if(!hits.length)treffer.push({regel:'struktur_oder_format',laenge:a.length});
    }else if(a&&b&&typeof a==='object'&&typeof b==='object'){
      for(const [k,v]of Object.entries(a))walk(v,(b as Record<string,unknown>)[k],istShellGeheimnisName(k)?k:name);
    }else treffer.push({regel:'struktur_oder_format',laenge:JSON.stringify(a)?.length??0});
  };
  walk(alt,neu);
  return treffer;
}

export async function shellAltbestandMaskieren(opt: { project?: string; ausfuehren: boolean; limit?: number; seit?:string; diagnose?:boolean }): Promise<Record<string, unknown>> {
  if(opt.seit && (!/^\d{4}-\d{2}-\d{2}T/.test(opt.seit)||!Number.isFinite(Date.parse(opt.seit))))throw new Error('seit muss ein gueltiger ISO-Zeitpunkt sein');
  const diagnose:MaskenDiagnose[]=[];let diagnoseGekappt=false;
  const pool = getPool();
  const werteCache = new Map<string, readonly string[]>();
  const werte = async (p: string): Promise<readonly string[]> => {
    if (!werteCache.has(p)) werteCache.set(p, await ladeShellWerte(p || undefined, { projektFs: p === 'synapse' }));
    return werteCache.get(p)!;
  };
  const grenze = opt.limit && opt.limit > 0 ? Math.floor(opt.limit) : Infinity;
  const aus: Record<string, Zaehlung> = {};
  let geschriebenGesamt = 0;
  const beginn = Date.now();
  for (const t of Object.keys(FELDER) as Tabelle[]) {
    const z: Zaehlung = (aus[t] = { geprueft: 0, zu_aendern: 0, laufend: 0, geschrieben: 0, werte: 0, uebersprungen: 0, fehler: 0 });
    let nach: string | number | null = null;
    seiten: while (true) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (t === 'tool_calls') where.push("tool_name='shell'");
      if (opt.project) { params.push(opt.project); where.push('project=$' + params.length); }
      if (opt.seit) {params.push(opt.seit);where.push((t==='shell_jobs'?'created_at':'ts')+'>=$'+params.length+'::timestamptz');}
      if (nach !== null) { params.push(nach); where.push(idSpalte(t) + '>$' + params.length); }
      const zeilen = (await pool.query(
        'SELECT ' + idSpalte(t) + ' AS id,project,' + FELDER[t].join(',') + (t === 'shell_jobs' ? ',status' : '') +
        ' FROM ' + t + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY 1 LIMIT ' + SEITE, params)).rows;
      if (zeilen.length === 0) break;
      nach = t === 'shell_jobs' ? zeilen[zeilen.length - 1].id : Number(zeilen[zeilen.length - 1].id);
      for (const r of zeilen) {
        z.geprueft++;
        const vorher = daten(t, r);
        const { daten: neu } = maskiereShellDaten(vorher, await werte(r.project ?? ''), true);
        if (JSON.stringify(neu) === JSON.stringify(vorher)) continue;
        if (laufend(t, r.status)) { z.laufend++; continue; }
        z.zu_aendern++;
        if(opt.diagnose && !opt.ausfuehren){
          const w=await werte(r.project??'');
          for(const feld of FELDER[t]){
            if(JSON.stringify(vorher[feld])===JSON.stringify(neu[feld]))continue;
            if(diagnose.length>=100){diagnoseGekappt=true;continue;}
            const treffer=diagnoseFeld(vorher[feld],neu[feld],w);
            diagnose.push({tabelle:t,id:String(r.id),feld,
              ohne_wertliste:JSON.stringify(maskiereShellDaten({[feld]:vorher[feld]},[],true).daten[feld])!==JSON.stringify(vorher[feld]),
              treffer:treffer.slice(0,100),treffer_gekappt:treffer.length>100});
          }
        }
        if (!opt.ausfuehren || geschriebenGesamt >= grenze) continue;
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query("SET LOCAL lock_timeout = '3s'");
          await c.query("SET LOCAL statement_timeout = '30s'");
          await c.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
          const akt = (await c.query(
            'SELECT project,' + FELDER[t].join(',') + (t === 'shell_jobs' ? ',status' : '') + ' FROM ' + t + ' WHERE id=$1 FOR UPDATE',
            [r.id])).rows[0];
          if (!akt || laufend(t, akt.status)) { z.uebersprungen++; await c.query('ROLLBACK'); continue; }
          const alt = daten(t, akt);
          const { daten: m, maskiert } = maskiereShellDaten(alt, await werte(akt.project ?? ''), true);
          if (JSON.stringify(m) === JSON.stringify(alt)) { z.uebersprungen++; await c.query('ROLLBACK'); continue; }
          const spalten = FELDER[t];
          const werteNeu = spalten.map((k) => (k === 'tail' && m[k] != null ? JSON.stringify(m[k]) : m[k]));
          await c.query('UPDATE ' + t + ' SET ' + spalten.map((k, i) => k + '=$' + (i + 1)).join(',') + ' WHERE id=$' + (spalten.length + 1),
            [...werteNeu, r.id]);
          await c.query('COMMIT');
          z.geschrieben++; z.werte += maskiert; geschriebenGesamt++;
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          z.fehler++;
          console.error('[intern shell_altbestand_maskieren]', t, String(r.id).slice(0, 8), (e as { code?: string }).code ?? (e as Error).name);
        } finally {
          c.release();
        }
        if (geschriebenGesamt >= grenze) break seiten;
      }
    }
  }
  const rest = Object.values(aus).reduce((n, z) => n + z.zu_aendern - z.geschrieben, 0);
  return {
    success: true,
    action: 'shell_altbestand_maskieren',
    modus: opt.ausfuehren ? 'ausgefuehrt' : 'vorschau',
    project: opt.project ?? null,
    ...(opt.seit?{seit:opt.seit}:{}),
    ...(opt.diagnose&&!opt.ausfuehren?{diagnose,diagnose_gekappt:diagnoseGekappt}:{}),
    tabellen: aus,
    offen_danach: opt.ausfuehren ? rest : undefined,
    sekunden: Math.round((Date.now() - beginn) / 1000),
    hinweis: opt.ausfuehren
      ? (rest > 0 ? 'Weitere Zeilen offen: erneut mit ausfuehren:true aufrufen.' : 'Fertig. Ein weiterer Lauf muss 0 aendern.')
      : 'Nur gezaehlt. Schreiben mit ausfuehren:true (nur Koordinator/User, nicht umkehrbar).',
  };
}

/** Dispatcher-Anteil. Wirft nie. */
export async function fuehreShellAltAus(action: ShellAltAction, a: Record<string, unknown>, agentId?: string): Promise<Record<string, unknown>> {
  try {
    const ausfuehren = a.ausfuehren === true || a.ausfuehren === 'true';
    if (ausfuehren && !darfKoordinatorOderUser(agentId)) {
      return { success: false, action, error: 'nicht_erlaubt', message: 'ausfuehren:true nur fuer Koordinator oder User. Vorschau ist fuer alle erlaubt.' };
    }
    const project = typeof a.project === 'string' && a.project.trim() !== '' ? a.project.trim() : undefined;
    const limitRoh = typeof a.limit === 'number' ? a.limit : typeof a.limit === 'string' ? Number(a.limit) : undefined;
    const limit = limitRoh !== undefined && Number.isFinite(limitRoh) && limitRoh > 0 ? limitRoh : undefined;
    const seit = typeof a.seit==='string'?a.seit:undefined;
    const diagnose = a.diagnose===true || a.diagnose==='true';
    return await shellAltbestandMaskieren({ project, ausfuehren, limit, seit, diagnose });
  } catch (e) {
    return { success: false, action, error: 'fehler', message: (e as Error).message };
  }
}
