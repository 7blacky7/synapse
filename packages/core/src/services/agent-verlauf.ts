/**
 * P22-T78 (F1, Entwurf 222e11f5; mit P22-T81 696ca614): EIN Baustein fuer Uebergabe und Startkontext, je identity_id. Der Main ist
 * nur ein Fall (hauptagent-verlauf.ts ruft ihn mit seiner ID und seinen Werten; erzeugeVerlaufUebergabe bleibt byte-gleich).
 *
 * UEBERGABE (baueUebergabeText): letzte N Zuege VOLL aus hauptagent_verlauf (Ausloeser, Antwort, Werkzeug-Ein/Ausgaben) plus
 *   Kurzstand (juengster eigener Handoff bzw. hands_off-Thought, offene Auftraege, Ausloeser der letzten Zuege). Budget =
 *   min(20 % des Zielfensters, Handoff-Schwelle - Grundlast - Reserve), gezaehlt mit dem Verfahren der Zielfamilie; ein Zug, der
 *   nicht mehr passt, wird nicht gekuerzt, sondern per Verlaufs-ID genannt.
 * STARTKONTEXT (baueStartkontext): GEDAECHTNIS-Kopf + eigene Hinweise (Main: Sonderstellung P22-T79 + Projektliste; alle:
 *   selbststaendig arbeiten, P22-T72/T82) + Kurzstand + Zuege. NUR bei Beginn eines NEUEN LAUFS (User 7762d427): die einzige
 *   Lesestelle ist die System-Prompt-Route (startkontextFuer), die ein Wrapper nur beim Prozessstart und bei jeder Rotation liest
 *   (Claude: System-Prompt des neuen Prozesses; Codex: vor der ersten Nachricht des NEUEN Threads, resume behaelt ihn). Nie je
 *   Nachricht.
 * NACHWEIS je Lauf (Schema 128): beim Bauen agent_identitaeten.startkontext_offen; die naechste Anmeldung (= neuer Lauf) bucht ihn
 *   genau einmal auf agent_identitaet_laeufe.startkontext_am/startkontext_meta (bucheStartkontextAufLauf). Zusaetzlich traegt die
 *   juengste Wechsel-Zeile im Verlauf meta.uebergabe_eingespielt.
 * SCHALTER 'startkontext' (Produkt-Schalter, Katalog, STANDARD EIN, nur ausdruecklich): intern-Override > Produkt-Schalter global >
 *   Standard EIN. AUS = Bestand (Uebergabe nur als Thought-Hinweis der Anmeldung).
 * DEBUG: letzterStartkontextStand() (verlaufStatus), Spalten oben, Feld startkontext der Prompt-Route.
 */
import { getPool } from '../db/client.js';
import { pruefeRespawnKorridor } from './specialist-respawn.js';
import { HAUPTAGENT_PROJEKT } from './virtuelle-projekte.js';
import { modellFamilie, zaehleTokens, leseKalibrierung, type ModellFamilie } from './verlauf-tokens.js';
import { WRAPPER_ZIEL_SQL, wrapperRuntime } from './runtime-daemon-zugang.js';
import { leseMainSchalter, sichtbareUserProjekte } from './hauptagent-sonderstellung.js';
import type { VerlaufRolle, VerlaufWeg, VerlaufWerkzeuge } from './hauptagent-verlauf.js';

export const STARTKONTEXT_FUNKTION = 'startkontext' as const;

/** Reserve fuer Handoff-Turn und grosse Werkzeugaufrufe (wie HANDOFF_VORLAUF_TOKENS). */
const UEBERGABE_RESERVE = 30_000;
/** Grundlast, wenn fuer das Ziel noch keine gemessen wurde (Systemprompt + Werkzeugliste + CLI). */
const UEBERGABE_GRUNDLAST_STANDARD = 20_000;
const UEBERGABE_ANTEIL_FENSTER = 0.2;

interface UebergabeZeile { id: string; rolle: VerlaufRolle; weg: VerlaufWeg; quelle_ref: string | null; antwort_auf: string | null; text: string;
  werkzeuge: VerlaufWerkzeuge; meta: Record<string, unknown>; absender: Record<string, unknown> | null; erstellt_am: Date }

function werkzeugText(name: unknown, input: unknown, output: unknown): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? null));
  return `[Werkzeug ${String(name ?? 'werkzeug')}] Eingabe: ${s(input)}` + (output === undefined ? '' : `\n[Ergebnis] ${s(output)}`);
}

export interface UebergabeTeile {
  /** fertiger Uebergabe-Text (Thought beim Wechsel) */
  text: string;
  kurz: string; bloecke: string[]; summe: number; verwiesen: string[]; familie: ModellFamilie; budget: number;
  von: string; nach: string; vonRuntime: string | null; zielModell: string; vonEffort: string | null;
}

interface IdentitaetsStand { project: string; agent_id: string; rolle: string; modell: string | null; runtime: string | null }

async function identitaetsStand(identity_id: string): Promise<IdentitaetsStand | null> {
  const r = await getPool().query<{ project: string; agent_id: string; rolle: string; m: string | null }>(
    'SELECT project, agent_id, rolle, COALESCE(modell_bestaetigt, modell_selbstauskunft) AS m FROM agent_identitaeten WHERE id = $1', [identity_id]);
  const z = r.rows[0];
  if (!z) return null;
  const w = await getPool().query<{ ziel: string | null; provider: string | null; model: string | null; status: string }>(
    `SELECT ${WRAPPER_ZIEL_SQL} AS ziel, w.provider, w.model, w.status FROM agent_identitaet_wrapper_status w WHERE w.identity_id = $1
      ORDER BY (w.status IN ('running','idle')) DESC LIMIT 1`, [identity_id]).catch(() => ({ rows: [] as Array<{ ziel: string | null; provider: string | null; model: string | null; status: string }> }));
  const ws = w.rows[0];
  const lebt = !!ws && (ws.status === 'running' || ws.status === 'idle');
  return { project: z.project, agent_id: z.agent_id, rolle: z.rolle, modell: (lebt && ws.model?.trim()) || z.m,
    runtime: ws ? wrapperRuntime(ws.ziel, ws.provider, ws.model) : null };
}

/**
 * Uebergabe-Text einer Identitaet. o.von_modell/o.von_runtime: Werte des Aufrufers (Main: aktuellesMainModell/zugewieseneMainRuntime),
 * sonst aus Identitaet und Wrapper-Status. Wirft bei DB-Fehlern (Aufrufer fangen).
 */
export async function baueUebergabeText(identity_id: string, ziel: { runtime?: string | null; modell?: string | null; effort?: string | null },
  anlass: string, o: { handoff_thought_id?: string | null; von_modell?: string | null; von_runtime?: string | null } = {}): Promise<UebergabeTeile> {
  const pool = getPool();
  const stand = await identitaetsStand(identity_id);
  const project = stand?.project ?? HAUPTAGENT_PROJEKT;
  const agentId = stand?.agent_id ?? 'hauptagent';
  const vonModell = o.von_modell !== undefined ? o.von_modell : stand?.modell ?? null;
  const vonRuntime = o.von_runtime !== undefined ? o.von_runtime : stand?.runtime ?? null;
  const zielModell = ziel.modell ?? vonModell ?? 'unbekannt';
  const familie = modellFamilie(ziel.runtime ?? vonRuntime, zielModell);
  const faktor = (await leseKalibrierung(identity_id, familie))?.faktor ?? null;
  const schwellen = (await pruefeRespawnKorridor({ model: zielModell, tokens: 0 })).schwellen;
  const budget = Math.max(0, Math.min(Math.floor(schwellen.ceiling * UEBERGABE_ANTEIL_FENSTER),
    schwellen.handoffTokens - UEBERGABE_GRUNDLAST_STANDARD - UEBERGABE_RESERVE));
  // Kurzstand
  const eigen = o.handoff_thought_id
    ? await pool.query<{ id: string; content: string }>('SELECT id, content FROM thoughts WHERE id::text = $1', [o.handoff_thought_id])
    : await pool.query<{ id: string; content: string }>(
      `SELECT id, content FROM thoughts WHERE project = $1 AND (source_identity_id = $2 OR source = $3)
         AND tags && ARRAY['auto-handoff','session-state','session-uebergabe']::text[] AND NOT ('verlauf-uebergabe' = ANY(tags))
       ORDER BY "timestamp" DESC LIMIT 1`, [project, identity_id, agentId]);
  const auftraege = await pool.query<{ art: string; status: string; gewuenscht: unknown }>(
    `SELECT art, status, gewuenscht FROM agent_runtime_auftraege WHERE identity_id = $1 AND status IN ('pending','claimed','accepted') ORDER BY erstellt_am`,
    [identity_id]).catch(() => ({ rows: [] as Array<{ art: string; status: string; gewuenscht: unknown }> }));
  // Zuege: Ausloeser (Web-UI-User oder Nachricht, nicht die Sitzungs-Eintraege) mit Antwort und Werkzeugschritten dazwischen.
  const ausloeser = (await pool.query<UebergabeZeile>(
    `SELECT id::text AS id, rolle, weg, quelle_ref, antwort_auf::text AS antwort_auf, text, werkzeuge, meta, absender, erstellt_am
       FROM hauptagent_verlauf WHERE identity_id = $1 AND rolle IN ('user','nachricht') AND (quelle_ref IS NULL OR quelle_ref NOT LIKE 'jsonl:%')
      ORDER BY hauptagent_verlauf.id DESC LIMIT 200`, [identity_id])).rows;
  // P22-T81: Identitaeten ohne Web-UI-/Zustellzeilen (Spezialisten, Koordinatoren) haben nur ihre Sitzungszeilen (jsonl).
  const sitzung = ausloeser.length ? [] : await sitzungsZuege(identity_id);
  const bloecke: string[] = [];
  const verwiesen: string[] = [];
  let summe = 0;
  for (const a of ausloeser) {
    const antwort = (await pool.query<UebergabeZeile>(
      `SELECT id::text AS id, rolle, weg, quelle_ref, antwort_auf::text AS antwort_auf, text, werkzeuge, meta, absender, erstellt_am
         FROM hauptagent_verlauf WHERE antwort_auf = $1::bigint`, [a.id])).rows[0];
    const schritte = antwort ? (await pool.query<UebergabeZeile>(
      `SELECT id::text AS id, rolle, weg, quelle_ref, antwort_auf::text AS antwort_auf, text, werkzeuge, meta, absender, erstellt_am
         FROM hauptagent_verlauf WHERE identity_id = $1 AND quelle_ref LIKE 'jsonl:%' AND weg = 'werkzeug'
          AND id > $2::bigint AND id < $3::bigint ORDER BY hauptagent_verlauf.id`, [identity_id, a.id, antwort.id])).rows : [];
    const teile = [`### Zug ${a.id} · ${a.weg} · ${a.erstellt_am.toISOString()}${a.absender?.agent_id ? ' · von ' + String(a.absender.agent_id) : ''}`, a.text];
    for (const c of antwort?.werkzeuge?.calls ?? []) teile.push(werkzeugText(c.name, c.input, c.output));
    for (const sz of schritte) teile.push(sz.rolle === 'ausgabe' ? werkzeugText(sz.meta.name, sz.meta.inhalt ?? sz.text, undefined) : '[Ergebnis] ' + sz.text);
    teile.push('--- Antwort ---', antwort?.text ?? '(keine Antwort)');
    const block = teile.join('\n');
    const t = (await zaehleTokens(block, familie, faktor)).tokens;
    if (summe + t > budget || verwiesen.length) { verwiesen.push(a.id); continue; }
    bloecke.unshift(block);
    summe += t;
  }
  for (let k = sitzung.length - 1; k >= 0; k--) {
    const t = (await zaehleTokens(sitzung[k].text, familie, faktor)).tokens;
    if (summe + t > budget || verwiesen.length) { verwiesen.push(sitzung[k].id); continue; }
    bloecke.unshift(sitzung[k].text);
    summe += t;
  }
  const kurz = [
    '## Kurzstand',
    '- Juengster eigener Handoff: ' + (eigen.rows[0] ? `(thought ${eigen.rows[0].id})\n${eigen.rows[0].content}` : 'keiner'),
    '- Offene Auftraege: ' + (auftraege.rows.length ? auftraege.rows.map((x) => `${x.art} (${x.status}) ${JSON.stringify(x.gewuenscht)}`).join('; ') : 'keine'),
    '- Letzte Anliegen: ' + (ausloeser.slice(0, 10).map((x) => `[${x.id}] ${x.text.split('\n').find((z) => z.trim())?.trim() ?? ''}`).join(' | ') || 'keine'),
  ].join('\n');
  const von = `${vonRuntime ?? '?'}/${vonModell ?? '?'}`;
  const nach = `${ziel.runtime ?? vonRuntime ?? '?'}/${zielModell}`;
  // P22-T65: Effort-Aenderung sichtbar ('Effort X -> Y'); X = gespeicherte Stufe des bisherigen Modells bzw. Standard.
  const vonEffort = ziel.effort && vonModell
    ? (await pool.query<{ e: string | null }>(`SELECT startrezept->'effort_je_modell'->>$2 AS e FROM agent_identitaeten WHERE id = $1`,
      [identity_id, vonModell]).catch(() => ({ rows: [] as Array<{ e: string | null }> }))).rows[0]?.e ?? null : null;
  const text = [
    `VERLAUF-UEBERGABE (Synapse, Anlass ${anlass}, ${von} -> ${nach}, ${new Date().toISOString()})`,
    'Startkontext aus deinem vollstaendigen Verlauf: die letzten Zuege in voller Laenge, darunter ein Kurzstand. Arbeite daran weiter.',
    kurz, `## Letzte ${bloecke.length} Zuege (voll, ~${summe} Tokens, ${familie})`, ...bloecke,
    ...(verwiesen.length ? [`## Weitere Zuege im Verlauf (nicht mitgegeben, Verlaufs-IDs): ${verwiesen.join(', ')}`] : []),
  ].join('\n\n');
  return { text, kurz, bloecke, summe, verwiesen, familie, budget, von, nach, vonRuntime, zielModell, vonEffort };
}

/**
 * P22-T72/T82 (User cffe5f66, fd869466): Selbststaendigkeit als Haltung, KEINE Schrittfolge. Main: der User sitzt im Chat, will aber
 * keine Zwischenfreigaben; alle anderen: kein User anwesend, Rueckfragen nur ueber Koordinator/Channel.
 */
export function autonomieHinweis(rolle: string): string {
  return rolle === 'main'
    ? 'Arbeite Auftraege selbststaendig bis zum Ende aus. Bitte nicht um Zwischenfreigaben und frage nicht "soll ich fortfahren?" - '
      + 'mach weiter. Frage den User nur, wenn eine Entscheidung fehlt, die nur er treffen kann.'
    : 'Es ist KEIN User anwesend. Warte nie auf den User und bitte nicht um Freigaben: fuehre deine Aufgabe selbststaendig bis zum Ende '
      + 'aus. Echte Rueckfragen stellst du deinem Koordinator ueber chat oder den Channel und arbeitest bis zur Antwort am Rest weiter.';
}

/** Wie viele juengste Sitzungszeilen fuer die Zuege gelesen werden (danach greift ohnehin das Budget). */
const SITZUNG_ZEILEN_MAX = 400;

/**
 * P22-T81: Zuege aus den Sitzungszeilen (quelle jsonl, meta.art): ein Zug beginnt mit einer Eingabe (Spawn-Aufgabe, Weckruf, Inbox)
 * und enthaelt Werkzeug-Aufrufe/-Ergebnisse und Antworten bis zur naechsten Eingabe. Denkphasen bleiben draussen. Nichts gekuerzt.
 */
async function sitzungsZuege(identity_id: string): Promise<Array<{ id: string; text: string }>> {
  const r = await getPool().query<{ id: string; rolle: string; text: string; meta: Record<string, unknown>; erstellt_am: Date }>(
    `SELECT * FROM (SELECT id::text AS id, rolle, text, meta, erstellt_am FROM hauptagent_verlauf WHERE identity_id = $1
        ORDER BY hauptagent_verlauf.id DESC LIMIT ${SITZUNG_ZEILEN_MAX}) x ORDER BY x.id::bigint`, [identity_id]);
  const zuege: Array<{ id: string; teile: string[] }> = [];
  for (const z of r.rows) {
    const art = typeof z.meta?.art === 'string' ? z.meta.art : null;
    if (art === 'denken') continue;
    if (art === 'eingabe' || !zuege.length) zuege.push({ id: z.id, teile: [`### Zug ${z.id} · ${z.erstellt_am.toISOString()}`] });
    const zug = zuege[zuege.length - 1];
    if (art === 'eingabe') zug.teile.push('--- Eingabe ---', z.text);
    else if (art === 'werkzeug_aufruf') zug.teile.push(werkzeugText(z.meta.name, z.meta.inhalt ?? z.text, undefined));
    else if (art === 'werkzeug_ergebnis') zug.teile.push('[Ergebnis] ' + z.text);
    else if (art === 'text') zug.teile.push('--- Antwort ---', z.text);
    else zug.teile.push((z.rolle === 'system' ? '[System] ' : '') + z.text);
  }
  return zuege.map((z) => ({ id: z.id, text: z.teile.join('\n') }));
}

/**
 * P22-T81: Startpaket-Teile jeder Identitaet ausser dem Main: Pflichtregeln der Rolle im Volltext (Typ-Regeln, wenn der Typkatalog
 * greift; derselbe Satz wie im Onboarding) und eigene Hinweise aus dem letzten Spawn (Aufgabe, Fachgebiet, Channel, Ort Container).
 */
async function rolleUndAuftrag(identity_id: string, stand: IdentitaetsStand): Promise<{ regeln: string[]; hinweise: string[] }> {
  const { getOnboardingMemories } = await import('./memory.js');
  const { baueOnboardingRegelwerk, rolleFuerAgent, wendeTypRegelnAn } = await import('./agent-rollen.js');
  const { typRegelnFuer } = await import('./agent-lauf.js');
  const memories = await getOnboardingMemories(stand.project);
  let regelwerk = baueOnboardingRegelwerk(memories, stand.project, rolleFuerAgent(stand.agent_id, stand.rolle).rolle);
  const typ = await typRegelnFuer(identity_id, stand.project).catch(() => null);
  if (typ) regelwerk = wendeTypRegelnAn(regelwerk, memories, typ);
  const regeln = regelwerk.rules.filter((x) => x.vollstaendig && typeof x.content === 'string' && x.content.trim()).map((x) => `### ${x.name}\n${x.content}`);
  const spawn = (await getPool().query<{ args: Record<string, unknown> | null }>(
    `SELECT args FROM specialist_jobs WHERE target_identity_id = $1 AND project = $2 AND action = 'spawn' ORDER BY created_at DESC LIMIT 1`,
    [identity_id, stand.project]).catch(() => ({ rows: [] as Array<{ args: Record<string, unknown> | null }> }))).rows[0]?.args ?? null;
  const hinweise = [
    `Du bist ${stand.agent_id} (Rolle ${stand.rolle}) im Projekt ${stand.project}; dein Ausweis bleibt derselbe, auch nach Modell-/Runtime-Wechsel.`,
    ...(typeof spawn?.task === 'string' ? [`Deine Aufgabe (letzter Start): ${spawn.task}`] : []),
    ...(typeof spawn?.expertise === 'string' ? [`Fachgebiet: ${spawn.expertise}`] : []),
    `Channel: ${typeof spawn?.channel === 'string' ? spawn.channel : stand.project + '-general'}`,
    ...(typeof spawn?.target_runtime === 'string'
      ? [`Ort: Runtime-Container ${spawn.target_runtime} ohne Projekt-Checkout. Dateien nur ueber files (plan/commit), lesen ueber code_intel, `
        + 'ausfuehren ueber shell (laeuft auf dem PC des Projekts oder, wenn keiner online ist, im Workspace-Container).']
      : []),
  ];
  return { regeln, hinweise };
}

export interface StartkontextNachweis { am: string; zuege: number; tokens: number; runtime: string | null; modell: string; uebergabe_thought_id: string | null }
let letzterStartkontext: (StartkontextNachweis & { identity_id: string }) | null = null;
/** Debug: zuletzt in diesem Prozess gebauter Startkontext. */
export function letzterStartkontextStand(): (StartkontextNachweis & { identity_id: string }) | null { return letzterStartkontext; }

/**
 * Startkontext einer Identitaet fuer ihren NEUEN Lauf (Schalter startkontext). Merkt den Nachweis als startkontext_offen; die naechste
 * Anmeldung bucht ihn auf den Lauf. Wirft nie (null = kein Anhang).
 */
export async function baueStartkontext(identity_id: string): Promise<{ text: string; zuege: number; tokens: number; nachweis: StartkontextNachweis } | null> {
  try {
    if (!(await leseMainSchalter(STARTKONTEXT_FUNKTION)).aktiv) return null;
    const pool = getPool();
    const stand = await identitaetsStand(identity_id);
    if (!stand) return null;
    const t = await baueUebergabeText(identity_id, { runtime: stand.runtime, modell: stand.modell }, 'neuer_lauf');
    const hinweise = ['## Eigene Hinweise', autonomieHinweis(stand.rolle)];
    let regeln: string[] = [];
    if (stand.rolle === 'main') {
      const projekte = await sichtbareUserProjekte();
      hinweise.push('Du bist der Main: du siehst ALLE Projekte des Users lesend ein (project:"<name>" angeben) und arbeitest nicht darin. '
        + `Projekte: ${projekte.length ? projekte.join(', ') : '(keine gefunden)'}.`);
    } else {
      // P22-T81: Startpaket jeder anderen Identitaet: Rolle/Regeln des Ausweis-Profils + eigene Hinweise (Aufgabe, Ort).
      const ra = await rolleUndAuftrag(identity_id, stand);
      hinweise.push(...ra.hinweise);
      regeln = ra.regeln;
    }
    const wechsel = (await pool.query<{ id: string; thought_id: string | null }>(
      `SELECT id::text AS id, meta->>'thought_id' AS thought_id FROM hauptagent_verlauf WHERE identity_id = $1 AND weg = 'wechsel'
        ORDER BY id DESC LIMIT 1`, [identity_id])).rows[0] ?? null;
    const text = [
      '## GEDAECHTNIS (von Synapse aus deinem vollstaendigen Verlauf eingespielt)',
      'Du bist dieselbe Persona wie in den Zuegen unten - nur Modell/Runtime koennen gewechselt haben. Das ist DEIN bisheriges Gespraech '
        + 'mit dem User (und den Agenten). Nutze es direkt (z. B. wie der User heisst, was er wollte), ohne es nachzuschlagen. '
        + 'Ein Uebergabe-Thought, den dir die Anmeldung nennt, enthaelt dasselbe.',
      hinweise.join('\n'),
      ...(regeln.length ? [`## Regeln deiner Rolle (${regeln.length})`, ...regeln] : []),
      t.kurz, `## Letzte ${t.bloecke.length} Zuege (voll, ~${t.summe} Tokens, ${t.familie})`, ...t.bloecke,
      ...(t.verwiesen.length ? [`## Weitere Zuege im Verlauf (nicht mitgegeben, Verlaufs-IDs): ${t.verwiesen.join(', ')}`] : []),
    ].join('\n\n');
    const nachweis: StartkontextNachweis = { am: new Date().toISOString(), zuege: t.bloecke.length, tokens: t.summe, runtime: stand.runtime,
      modell: t.zielModell, uebergabe_thought_id: wechsel?.thought_id ?? null };
    await pool.query('UPDATE agent_identitaeten SET startkontext_offen = $2::jsonb WHERE id = $1', [identity_id, JSON.stringify(nachweis)])
      .catch((e) => console.error(`[agent-verlauf] startkontext_offen nicht gesetzt: ${(e as Error).message}`));
    if (wechsel) {
      await pool.query(
        `UPDATE hauptagent_verlauf SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('uebergabe_eingespielt', true, 'eingespielt_am', $2::text, 'eingespielt_zuege', $3::int),
           rev = nextval('hauptagent_verlauf_rev'), aktualisiert_am = NOW()
         WHERE id = $1::bigint AND NOT COALESCE((meta->>'uebergabe_eingespielt')::boolean, false)`,
        [wechsel.id, nachweis.am, t.bloecke.length]).catch((e) => console.error(`[agent-verlauf] Wechsel-Nachweis: ${(e as Error).message}`));
    }
    letzterStartkontext = { ...nachweis, identity_id };
    return { text, zuege: t.bloecke.length, tokens: t.summe, nachweis };
  } catch (error) {
    console.error(`[agent-verlauf] Startkontext fuer ${identity_id} nicht gebaut: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Lesestelle der System-Prompt-Route: Startkontext fuer (Projekt, Agent) oder null. Main (synapse-hauptagent/hauptagent, Rolle main)
 * und (P22-T81) jede andere aktive Identitaet: Koordinatoren, Spezialisten am PC und im Container. Legacy-Agenten ohne Identitaet: null.
 */
export async function startkontextFuer(project: string, agent: string): Promise<{ text: string; zuege: number; tokens: number } | null> {
  const main = project === HAUPTAGENT_PROJEKT && agent === 'hauptagent';
  const r = await getPool().query<{ id: string }>(main
    ? "SELECT id FROM agent_identitaeten WHERE project = $1 AND agent_id = $2 AND rolle = 'main' AND status = 'aktiv' LIMIT 1"
    : "SELECT id FROM agent_identitaeten WHERE project = $1 AND agent_id = $2 AND status = 'aktiv' LIMIT 1", [project, agent])
    .catch(() => ({ rows: [] as Array<{ id: string }> }));
  if (!r.rows[0]) return null;
  const sk = await baueStartkontext(r.rows[0].id);
  return sk ? { text: sk.text, zuege: sk.zuege, tokens: sk.tokens } : null;
}

/** Bei der Anmeldung (neuer Lauf): offenen Startkontext GENAU EINMAL auf den Lauf buchen. Wirft nie. */
export async function bucheStartkontextAufLauf(identity_id: string, lauf_id: string | null | undefined): Promise<boolean> {
  if (!lauf_id) return false;
  try {
    const r = await getPool().query(
      `WITH o AS (SELECT startkontext_offen AS meta FROM agent_identitaeten WHERE id = $1 AND startkontext_offen IS NOT NULL FOR UPDATE),
       l AS (UPDATE agent_identitaet_laeufe l SET startkontext_am = COALESCE((o.meta->>'am')::timestamptz, NOW()), startkontext_meta = o.meta
               FROM o WHERE l.id = $2 AND l.identity_id = $1 AND l.startkontext_am IS NULL RETURNING l.id)
       UPDATE agent_identitaeten SET startkontext_offen = NULL WHERE id = $1 AND EXISTS (SELECT 1 FROM l)`, [identity_id, lauf_id]);
    return (r.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}
