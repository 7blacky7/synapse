/**
 * P22-T202: Web-UI-Start auf bestehender T183-Engine. Keine Freigabe/Budget-Automatik.
 * Kein Provideraufruf beim Lesen/Pruefen. CLI/API-Wechsel sperrt die Identitaet vor dem Stop.
 */
import { createHash } from 'node:crypto';
import {
  getPool, HAUPTAGENT_PROJEKT, hauptagentIdentitaetsId, stelleMainIdentitaetSicher,
  leseApiAuswahlSchalter, leseApiLaufWahl, mitApiWahlSperre, schreibeApiLaufWahl, type ApiLaufWahl,
  leseApiModelle, leseApiBudget, leseApiSchalter, apiAgentenStand, leseApiAgentenSchalter,
  leseApiLaufSchalter, leseApiLaufEinstellungen, legeApiLaufAn, legeApiEingangAn, steuereApiLauf,
  ladeSteuerZiel, pruefeSteuerRecht, listWrapperStatus, enqueueSpecialistJob, waitForSpecialistJob, jobErfolgreich,
  runtimeProjektPfad, leseRuntimeAgentenGrenzen, erzeugeVerlaufUebergabe, aktuellerApiKey, ProfilVerwaltungFehler,
  type SteuerAkteur, type ApiFreigabe,
} from '@synapse/core';
import { openRouterSchluessel } from './api-agent-transport.js';

function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }
async function ziel(id: string, akteur: SteuerAkteur | null) {
  const identity = id === 'main' ? await hauptagentIdentitaetsId() : id;
  if (!identity) return null;
  const z = await ladeSteuerZiel(identity);
  await pruefeSteuerRecht(akteur, z.project);
  if (z.status !== 'aktiv' || !['main','koordinator','subagent'].includes(z.rolle)) fehler('identitaet_nicht_aktiv');
  return z;
}
export async function apiAnbieterStand() {
  const a = await aktuellerApiKey(), o = openRouterSchluessel();
  return { 'anthropic-api': { vorhanden: !!a.key, quelle: a.quelle },
    'openrouter-api': { vorhanden: !!o.key, quelle: o.quelle } };
}
type FreigabeStand = ApiFreigabe & { rest_usd: number | null; api_agenten_aktiv: boolean };
export async function apiAuswahlStand(id: string, akteur: SteuerAkteur | null) {
  const z = await ziel(id, akteur);
  if (!z && akteur?.art !== 'user') fehler('recht_fehlt');
  const project = z?.project ?? HAUPTAGENT_PROJEKT;
  const schalter = await leseApiAuswahlSchalter(project);
  if (!schalter.aktiv) return { schalter, identity: z, modelle: [] as Awaited<ReturnType<typeof leseApiModelle>>, wahl: z ? await leseApiLaufWahl(z.identity_id) : null,
    budget:null,freigabe:null,anbieter:null,blocker:['funktion_aus'],lauf_schalter:null,api_schalter:null,agent_schalter:null,debug:null };
  const [modelle,budget,api,lauf,anbieter,wahl,grenzen] = await Promise.all([
    leseApiModelle(),leseApiBudget(),leseApiSchalter(),leseApiLaufSchalter(project),apiAnbieterStand(),
    z ? leseApiLaufWahl(z.identity_id) : null,leseApiLaufEinstellungen()]);
  const main = !z || z.rolle === 'main';
  const agenten = main ? null : await apiAgentenStand(project);
  const freigabe = z ? ((agenten?.freigaben ?? []) as FreigabeStand[]).find(f=>f.identity_id===z.identity_id) ?? null : null;
  const agentSchalter = main ? null : await leseApiAgentenSchalter(project);
  const plaetze = await getPool().query<{ n: number }>(
    "SELECT count(*)::int AS n FROM api_agent_laeufe WHERE lease_token IS NOT NULL AND lease_bis>NOW() AND ($1::text IS NULL OR identity_id<>$1)",[z?.identity_id ?? null]);
  const blocker = [
    ...(!lauf.aktiv ? ['api_lauf_aus'] : []),
    ...(!(main ? api.aktiv : api.api.aktiv && agentSchalter?.aktiv) ? ['funktion_aus'] : []),
    ...(!budget.gesetzt ? ['budget_fehlt'] : budget.erschoepft ? ['budget_erschoepft'] : []),
    ...(!main && !freigabe?.aktiv ? ['api_freigabe_fehlt'] : []),
    ...(!main && freigabe?.rest_usd !== null && freigabe?.rest_usd !== undefined && freigabe.rest_usd <= 0 ? ['agent_budget_erschoepft'] : []),
    ...(plaetze.rows[0].n >= grenzen.api_laeufe_max.wert ? ['api_laufplaetze_belegt'] : []),
  ];
  return { schalter, identity: z, modelle, budget, freigabe, anbieter, wahl,
    lauf_schalter: lauf, api_schalter: api, agent_schalter: agentSchalter, blocker,
    debug: { plaetze: plaetze.rows[0].n, maximum: grenzen.api_laeufe_max, einstellungen_fehler: grenzen.letzter_fehler } };
}
function pruefeModell(s: Awaited<ReturnType<typeof apiAuswahlStand>>, alias: string) {
  if (!s.schalter.aktiv) fehler('funktion_aus',{funktion:'api_agenten_auswahl'});
  if (s.blocker?.length) fehler(s.blocker[0],{blocker:s.blocker,einstellungen:'API-Agenten'});
  const m = s.modelle.find(x=>x.alias===alias);
  if (!m) fehler('modell_unbekannt');
  if (!(m.eingabe !== null && m.ausgabe !== null && m.eingabe > 0 && m.ausgabe > 0)) fehler('preis_unbekannt');
  if (!s.budget?.erlaubte_modelle.includes(alias)) fehler('modell_nicht_erlaubt');
  if (s.identity?.rolle !== 'main' && s.identity && !s.freigabe?.modelle.includes(alias)) fehler('modell_nicht_freigegeben');
  if (!s.anbieter?.[m.anbieter as 'anthropic-api'|'openrouter-api']?.vorhanden) fehler('api_zugang_fehlt',{anbieter:m.anbieter});
  return m;
}
async function keineOffenenStarts(db: import('pg').PoolClient, id: string, project: string, name: string) {
  const r = await db.query(`SELECT id FROM specialist_jobs WHERE project=$2 AND status IN ('pending','running')
    AND action IN ('spawn','spawn_batch') AND (target_identity_id=$1 OR args->>'identity_id'=$1 OR args->>'name' IN ($3,'identity:' || $1)
      OR action='spawn_batch' AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(args->'specialists','[]'::jsonb)) s
        WHERE s->>'identity_id'=$1 OR s->>'name' IN ($3,'identity:' || $1))) LIMIT 1`,[id,project,name]);
  if (r.rows.length) fehler('cli_start_offen');
  const main = await db.query("SELECT id FROM agent_runtime_auftraege WHERE identity_id=$1 AND status IN ('pending','claimed','accepted') LIMIT 1",[id]);
  if (main.rows.length) fehler('wechsel_offen');
}
export async function starteApiAuswahl(e: { identity_id?: unknown; modell?: unknown; auftrag?: unknown; grund?: unknown; kosten_bestaetigt?: unknown; wechsel_bestaetigt?: unknown; idempotenz_schluessel?: unknown }, akteur: SteuerAkteur | null) {
  const id = typeof e.identity_id === 'string' ? e.identity_id : '';
  const modell = typeof e.modell === 'string' ? e.modell.trim() : '';
  const grund = typeof e.grund === 'string' ? e.grund.trim() : '';
  const auftrag = typeof e.auftrag === 'string' ? e.auftrag.trim() : '';
  if (grund.length < 10) fehler('grund_fehlt');
  if (!auftrag || auftrag.length > 200_000) fehler('auftrag_fehlt');
  if (e.kosten_bestaetigt !== true || e.wechsel_bestaetigt !== true) fehler('kostenbestaetigung_fehlt');
  const schluessel = typeof e.idempotenz_schluessel === 'string' ? e.idempotenz_schluessel.trim() : null;
  if(schluessel && !/^[a-zA-Z0-9_-]{16,128}$/.test(schluessel)) fehler('idempotenz_ungueltig');
  const auftrag_hash=createHash('sha256').update(auftrag).digest('hex');
  let s = await apiAuswahlStand(id,akteur);
  if(schluessel && s.wahl?.idempotenz_schluessel===schluessel && s.wahl.phase==='aktiv') {
    if(s.wahl.modell!==modell || s.wahl.auftrag_hash!==auftrag_hash) fehler('idempotenz_konflikt');
    return {identity_id:s.identity!.identity_id,wahl:s.wahl,idempotent:true,eingang:{id:s.wahl.eingang_id}};
  }
  const m = pruefeModell(s,modell);
  if (!s.identity) {
    if (id !== 'main' || akteur?.art !== 'user') fehler('identitaet_unbekannt');
    const angelegt = await stelleMainIdentitaetSicher({art:'user'});
    s = await apiAuswahlStand(angelegt.identity_id,akteur);
    pruefeModell(s,modell);
  }
  const z = s.identity!;
  const wer = await pruefeSteuerRecht(akteur,z.project);
  const w: ApiLaufWahl = { laufart:'api', modell, anbieter:m.anbieter, phase:'wechsel', grund, wer, am:new Date().toISOString(), ...(schluessel ? {idempotenz_schluessel:schluessel,auftrag_hash} : {}) };
  // A: serialisiert mit allen CLI-Starts; ein alter offener Start muss erst fertig sein.
  await mitApiWahlSperre([z.identity_id],async db=>{
    await keineOffenenStarts(db,z.identity_id,z.project,z.agent_id);
    const chats = await db.query("SELECT 1 FROM agent_runtime_sessions WHERE identity_id=$1 AND status='running' LIMIT 1",[z.identity_id]);
    if(chats.rows.length) fehler('main_chat_turn_aktiv');
    const alt = await db.query<{aktiv:boolean}>("SELECT (lease_token IS NOT NULL AND lease_bis>NOW()) AS aktiv FROM api_agent_laeufe WHERE identity_id=$1 FOR UPDATE",[z.identity_id]);
    if (alt.rows[0]?.aktiv) fehler('lauf_turn_aktiv');
    const wahl = await db.query<{phase:string}>("SELECT startrezept->'api_lauf_wahl'->>'phase' AS phase FROM agent_identitaeten WHERE id=$1",[z.identity_id]);
    if (wahl.rows[0]?.phase === 'wechsel') fehler('wechsel_laeuft');
    await schreibeApiLaufWahl(db,z.identity_id,w);
    await db.query("UPDATE api_agent_laeufe SET status='pausiert' WHERE identity_id=$1",[z.identity_id]);
  });
  try {
    // Handoff sichern, bevor der bisherige Prozess beendet wird.
    const uebergabe = await erzeugeVerlaufUebergabe(z.identity_id,{modell,runtime:null},'runtime_wechsel',null);
    const wrapper = (await listWrapperStatus(z.project)).filter(a=>a.identityId===z.identity_id && ['running','idle'].includes(a.status ?? ''));
    const grenzen = await leseRuntimeAgentenGrenzen();
    for (const a of wrapper) {
      const rt = a.provider === 'openai' ? 'codex' : z.runtime;
      const job = await enqueueSpecialistJob({project:z.project,action:'stop',args:{
        name:'identity:'+z.identity_id, identity_id:z.identity_id, wrapper_pid:a.wrapperPid,
        ...(z.ort==='container' && rt ? {target_runtime:rt,project_path:runtimeProjektPfad(z.project)}
          : z.hostname ? {target_hostname:z.hostname} : {}),
        audit:{wer,grund,aktion:'api_laufwahl'},
      }});
      if (!jobErfolgreich(await waitForSpecialistJob(job.id,grenzen.job_warte_ms))) fehler('stop_fehlgeschlagen',{job_id:job.id});
    }
    // B: frischer Prozessbeleg UND keine nachtraeglichen CLI-Starts. Kein paralleler Lauf.
    const nachher = (await listWrapperStatus(z.project)).filter(a=>a.identityId===z.identity_id && ['running','idle'].includes(a.status ?? ''));
    if (nachher.length) fehler('stop_nicht_bestaetigt');
    const frisch = await apiAuswahlStand(z.identity_id,akteur);
    pruefeModell(frisch,modell);
    return await mitApiWahlSperre([z.identity_id],async db=>{
      await keineOffenenStarts(db,z.identity_id,z.project,z.agent_id);
      const turn = await db.query("SELECT 1 FROM api_agent_laeufe WHERE identity_id=$1 AND lease_token IS NOT NULL AND lease_bis>NOW()",[z.identity_id]);
      if(turn.rows.length) fehler('lauf_turn_aktiv');
      const alt = await db.query<{modell:string}>("SELECT modell FROM api_agent_laeufe WHERE identity_id=$1",[z.identity_id]);
      if(alt.rows[0] && alt.rows[0].modell!==modell)
        await db.query("UPDATE api_agent_laeufe SET sitzung=gen_random_uuid(),neustarts=neustarts+1,kontext_tokens=NULL,kontext_fenster=NULL,kontext_anteil=NULL WHERE identity_id=$1",[z.identity_id]);
      const lauf = await legeApiLaufAn({identity_id:z.identity_id,project:z.project,agent_id:z.agent_id,rolle:z.rolle,
        modell,anbieter:m.anbieter,system_prompt:'Du bist '+z.agent_id+' ('+z.rolle+') im Projekt '+z.project+'. Nutze deine Synapse-Werkzeuge und beachte die Regeln deiner Anmeldung.',gestartet_von:wer},db);
      await db.query("UPDATE api_agent_laeufe SET status='bereit',letzter_fehler=NULL WHERE identity_id=$1",[z.identity_id]);
      const eingang = await legeApiEingangAn({identity_id:z.identity_id,text:(uebergabe ? 'Laufwechsel: Lies zuerst deine Übergabe thought '+uebergabe.thought_id+'.\n\n' : '')+auftrag,quelle:'auftrag',absender:wer},db);
      await schreibeApiLaufWahl(db,z.identity_id,{...w,phase:'aktiv',eingang_id:eingang.id});
      await db.query("INSERT INTO agent_identitaet_audit(identity_id,wer,aktion,neu,grund) VALUES($1,$2,'api_laufwahl',$3::jsonb,$4)",
        [z.identity_id,wer,JSON.stringify({modell,anbieter:m.anbieter,kosten_bestaetigt:true,eingang_id:eingang.id}),grund]);
      return {identity_id:z.identity_id,lauf, eingang,wahl:{...w,phase:'aktiv'},hinweis:'Auftrag eingereiht; Kosten werden erst nach dem Turn gemessen.'};
    });
  } catch(error) {
    await mitApiWahlSperre([z.identity_id],db=>schreibeApiLaufWahl(db,z.identity_id,{...w,phase:'fehler',fehler:(error as {code?:string}).code ?? 'start_fehlgeschlagen'}));
    throw error;
  }
}
/** API stoppen, Lease-Abschluss abwarten lassen, dann CLI-Weg freigeben. Kein automatischer CLI-Spawn. */
export async function beendeApiAuswahl(id: string, grund: string, akteur: SteuerAkteur | null) {
  const z = await ziel(id,akteur);
  if(!z) fehler('identitaet_unbekannt');
  if(grund.trim().length<10) fehler('grund_fehlt');
  const vorhanden=await getPool().query('SELECT 1 FROM api_agent_laeufe WHERE identity_id=$1',[z.identity_id]);
  if (!vorhanden.rows.length && !(await leseApiLaufWahl(z.identity_id))) return {identity_id:z.identity_id,laufart:'cli'};
  const ergebnis = await mitApiWahlSperre([z.identity_id],async db=>{
    const aktuell = await db.query<{phase:string}>("SELECT startrezept->'api_lauf_wahl'->>'phase' AS phase FROM agent_identitaeten WHERE id=$1",[z.identity_id]);
    if(aktuell.rows[0]?.phase==='wechsel') fehler('wechsel_laeuft');
    await db.query("UPDATE api_agent_laeufe SET status='gestoppt',aktualisiert_am=NOW() WHERE identity_id=$1",[z.identity_id]);
    const aktiv = await db.query("SELECT 1 FROM api_agent_laeufe WHERE identity_id=$1 AND lease_token IS NOT NULL AND lease_bis>NOW()",[z.identity_id]);
    if(aktiv.rows.length) return {blocker:'lauf_turn_aktiv' as const};
    const offen = await db.query("SELECT 1 FROM api_agent_eingang WHERE identity_id=$1 AND erledigt_am IS NULL LIMIT 1",[z.identity_id]);
    if(offen.rows.length) return {blocker:'api_eingaenge_offen' as const};
    await schreibeApiLaufWahl(db,z.identity_id,null);
    // Bestehender T183-Zusteller erkennt diese Marke: neue Nachrichten gehen ausschliesslich an die CLI.
    await db.query("UPDATE api_agent_laeufe SET letzter_fehler='rueckfall_container: ausdrueckliche CLI-Wahl (P22-T202)' WHERE identity_id=$1",[z.identity_id]);
    return {identity_id:z.identity_id,laufart:'cli',hinweis:'API beendet. CLI-Modell jetzt mit der vorhandenen Modellwahl starten.'};
  });
  // Stop muss trotz laufender Lease committed bleiben; erst danach den sichtbaren Blocker melden.
  if('blocker' in ergebnis) fehler(ergebnis.blocker!,{hinweis:'API gestoppt; laufenden Turn beenden bzw. offene API-Aufträge erst erledigen.'});
  return ergebnis;
}
