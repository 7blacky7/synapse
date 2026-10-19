/**
 * P7-T40: gemeinsamer Onboarding-Ladepfad. Erst vollständig aufbereiten, dann
 * atomar Zustellung beanspruchen. Explizite Anmeldung gehört ihrer eigenen Antwort.
 *
 * W12-B (P22-T25, Vertrag V5 zustellUmfang): Token-Agent mit aktivem Lauf bei wirksamem Ausweis-Kern ->
 * Zustellung JE LAUF statt je Identitaet/Prozess. Anmeldung/Sitzungssignal (explizit) = wie bisher alles, danach
 * ist der Regelstand im Lauf vermerkt. Folgeaufrufe im selben Lauf liefern nur Nichtzugestelltes: Pflichtregeln
 * voll, wenn im Lauf noch keine bzw. eine geaenderte zugestellt wurden (uebrige Regeln dann nur als Namen im
 * regel_verzeichnis), sonst nichts; Profilblock (W12-C) einmal je Lauf. Kern AUS bzw. Legacy-Agent: unveraendert.
 */
import { getOnboardingMemories } from './memory.js';
import { istOnboardingBekannt, registerAgent } from './project-status.js';
import { rolleFuerAgent, rollenQuelleKlartext, baueOnboardingRegelwerk, baueRegelAbrufHinweis, wendeTypRegelnAn, type OnboardingRegel } from './agent-rollen.js';
import { w12ZustellKontext, w12ProfilBlock, markiereZugestellt, typRegelnFuer } from './agent-lauf.js';
import { markiereWerkzeugRegelnZugestellt } from './werkzeug-regeln.js';
import { TEXT_NEUINSTANZ } from './agent-profil-vertrag.js';
import { getPool } from '../db/client.js';
import type { RegelVerzeichnis } from './agent-rollen.js';

type W12Principal = NonNullable<Awaited<ReturnType<typeof w12ZustellKontext>>>['principal'];

/** P22-T50: leer = null/undefined/'' / leere Liste / Objekt nur aus leeren Werten (0 und false sind Werte). */
function istLeer(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).every(istLeer);
  return false;
}
function ohneLeere(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => !istLeer(v)));
}

/**
 * P22-T50 (User 19.10.): Profilblock ohne Leerfelder und ohne Doppelungen. identity_id/agent_id/project stehen im principal,
 * die rolle im Onboarding; regeln entfallen, wenn sie als Typ-Regeln schon in rules/regeln stehen.
 */
function kompaktesProfil(block: object, o: { rolle: string; ohneRegeln: boolean }): Record<string, unknown> {
  const weg = new Set(['identity_id', 'agent_id', 'project', ...(o.ohneRegeln ? ['regeln'] : [])]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(block as Record<string, unknown>)) {
    if (weg.has(k) || istLeer(v) || (k === 'rolle' && v === o.rolle)) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? ohneLeere(v as Record<string, unknown>) : v;
  }
  return out;
}

/**
 * P22-T50: Profilblock (einmal je Lauf), Profil-Channels und gebundene Tasks fuer das Onboarding - kompakt, nur Nichtleeres.
 * Ein Profil ohne Inhalt ausser profil_revision entfaellt (gilt trotzdem als zugestellt: zugestellt = Profilblock im Lauf vermerkt).
 */
async function profilTeilFuer(principal: W12Principal, rolle: string, ohneRegeln: boolean): Promise<{ teil: Record<string, unknown>; zugestellt: boolean }> {
  const teil: Record<string, unknown> = {};
  let zugestellt = false;
  try {
    const { baueFortsetzungsErgaenzung } = await import('./agent-profil-update.js');
    const erg = await baueFortsetzungsErgaenzung(principal);
    if (erg.profil) {
      zugestellt = true;
      const p = kompaktesProfil(erg.profil, { rolle, ohneRegeln });
      if (Object.keys(p).some((k) => k !== 'profil_revision')) teil.profil = p;
    }
    if (erg.profil_channels && !istLeer(erg.profil_channels)) teil.profil_channels = ohneLeere(erg.profil_channels as unknown as Record<string, unknown>);
    if (erg.gebundene_tasks?.length) teil.gebundene_tasks = erg.gebundene_tasks;
  } catch { /* Profilblock ist Zugabe */ }
  return { teil, zugestellt };
}

/** P22-T50: zustellung ohne das Vertragsfeld fortsetzung (es gibt mit Ausweis keinen fortsetzung-Block mehr). */
function zustellAnzeige<T extends { fortsetzung?: unknown }>(umfang: T): Omit<T, 'fortsetzung'> {
  const { fortsetzung: _fortsetzung, ...rest } = umfang;
  return rest;
}

/**
 * P22-T49 (User-Entscheidung c7ba27b4): Inhalt der kurzen Koordinator-Anmeldung. null = Produkt-Schalter
 * profilverwaltung im Projekt AUS -> Bestand (volles Onboarding). Haengt sonst am Ausweis-Kern (Aufrufer prueft w12).
 */
async function baueKoordinatorKurz(
  project: string, agentId: string, identityId: string,
  regelwerk: { rules: OnboardingRegel[]; regel_verzeichnis: RegelVerzeichnis }, mitTyp: boolean,
): Promise<{ handoff: { id: string; zeit: string; empfehlung: string } | null; aktiver_plan: unknown; aktiver_plan_hinweis?: string; top3: string[]; regeln: Record<string, unknown>;
  channels: { aktiv?: string[]; standard?: string[]; zeile?: string } | null; skills_andere: string[] } | null> {
  const { leseProfilProduktSchalter } = await import('./agent-profil-schalter.js');
  if (!(await leseProfilProduktSchalter('profilverwaltung', project)).aktiv) return null;
  const h = (await getPool().query<{ id: string; zeit: Date | string }>(
    `SELECT id, "timestamp" AS zeit FROM thoughts
      WHERE project=$1 AND 'session-uebergabe' = ANY(tags)
        AND (source_identity_id=$2 OR (source_identity_id IS NULL AND source=$3))
      ORDER BY COALESCE(source_identity_id=$2, false) DESC, "timestamp" DESC LIMIT 1`, [project, identityId, agentId])).rows[0];
  const { koordinatorPlanKurz } = await import('./plans.js');
  const lage = await koordinatorPlanKurz(project);
  // Praezisierung User (ausweis-fix 27970/27971): nur AKTIVE Channels SEIT DEM AUSWEIS + Standardchannel + Gesamtzahl.
  // Aktiv = mit Ausweis beigetreten (Mitgliedszeile der Identitaet ab dem ersten Lauf, NICHT die von der
  // Uebernahme-Bruecke kopierte Legacy-Mitgliedschaft mit gleichem joined_at) oder seit Ausweis-Beginn mit
  // sender_identity_id geschrieben. Ausweis-Beginn = erster Lauf der Identitaet (Rueckfall erstellt_am).
  const standardName = `${project}-general`;
  const ch = (await getPool().query<{ name: string; aktiv: boolean }>(
    `WITH b AS (
       SELECT COALESCE((SELECT MIN(l.erstellt_am) FROM agent_identitaet_laeufe l WHERE l.identity_id=$2),
                       (SELECT i.erstellt_am FROM agent_identitaeten i WHERE i.id=$2)) AS beginn,
              ARRAY(SELECT DISTINCT q.x FROM (
                SELECT $3::text AS x
                UNION SELECT l.uebernommen_aus->>'agent_id' FROM agent_identitaet_laeufe l
                 WHERE l.identity_id=$2 AND l.uebernommen_aus IS NOT NULL) q WHERE q.x IS NOT NULL) AS legacy_namen)
     SELECT c.name,
            (EXISTS (SELECT 1 FROM agent_identitaet_channel_mitglieder m, b
               WHERE m.channel_id=c.id AND m.identity_id=$2 AND m.joined_at >= b.beginn
                 AND NOT EXISTS (SELECT 1 FROM specialist_channel_members lm
                                  WHERE lm.channel_id=m.channel_id AND lm.agent_name = ANY(b.legacy_namen) AND lm.joined_at = m.joined_at))
             OR EXISTS (SELECT 1 FROM specialist_channel_messages x, b
                         WHERE x.channel_id=c.id AND x.sender_identity_id::text=$2 AND x.created_at >= b.beginn)) AS aktiv
       FROM specialist_channels c
      WHERE c.project=$1 AND c.archiviert_am IS NULL AND c.name NOT LIKE '%~archiv-%'
      ORDER BY (SELECT MAX(x.id) FROM specialist_channel_messages x WHERE x.channel_id=c.id) DESC NULLS LAST, c.name`,
    [project, identityId, agentId])).rows;
  // P22-T50 (User 8ca302e0): leere Teile weglassen. Hat die Identitaet seit dem Ausweis keinen Channel (nie aktiv beigetreten
  // oder geschrieben), entfaellt auch die Gesamtzeile; ganz ohne Inhalt fehlt channels.
  const aktivNamen = ch.filter((z) => z.aktiv).map((z) => z.name);
  const standard = ch.some((z) => z.name === standardName) ? [standardName] : [];
  const channelTeile = {
    ...(aktivNamen.length ? { aktiv: aktivNamen } : {}),
    ...(standard.length ? { standard } : {}),
    ...(aktivNamen.length ? { zeile: `${ch.length} Channels insgesamt, Liste: channel(action:"list", project:"${project}")` } : {}),
  };
  const channels = Object.keys(channelTeile).length ? channelTeile : null;
  // Praezisierung User (ausweis-fix 27973/27974): Skills ANDERER Typen/Ausweise nur als 'Typ » Anzahl', nur Typen
  // (scope projekt) und Identitaeten DIESES Projekts, ohne globale Typen/Skills, ohne eigenen Typ und eigene Identitaet.
  let skillsAndere: string[] = [];
  try {
    skillsAndere = (await getPool().query<{ typ: string; n: number }>(
      `WITH eigen AS (SELECT typ_id FROM agent_identitaeten WHERE id=$2),
       quelle AS (
         SELECT t.schluessel AS typ, s.x AS skill FROM agent_typen t
           JOIN agent_typ_revisionen r ON r.typ_id=t.id AND r.revision=t.aktuelle_revision
           CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.inhalt->'skills')='array' THEN r.inhalt->'skills' ELSE '[]'::jsonb END) s(x)
          WHERE t.scope='projekt' AND t.project=$1 AND t.id IS DISTINCT FROM (SELECT typ_id FROM eigen)
         UNION ALL
         SELECT COALESCE(t.schluessel, 'ohne Typ'), s.x FROM agent_identitaeten i
           LEFT JOIN agent_typen t ON t.id=i.typ_id
           CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(i.profil->'skills')='array' THEN i.profil->'skills' ELSE '[]'::jsonb END) s(x)
          WHERE i.project=$1 AND i.id<>$2 AND i.status='aktiv'
         UNION ALL
         SELECT COALESCE(t.schluessel, 'ohne Typ'), s.skill_name FROM agent_identitaet_skill_sections s
           JOIN agent_identitaeten i ON i.id=s.identity_id AND i.project=$1 AND i.id<>$2 AND i.status='aktiv'
           LEFT JOIN agent_typen t ON t.id=i.typ_id
          WHERE s.scope='agent' AND s.project=$1)
       SELECT typ, COUNT(DISTINCT skill)::int AS n FROM quelle GROUP BY typ ORDER BY typ`,
      [project, identityId])).rows.map((z) => `${z.typ} » ${z.n}`);
  } catch { /* Zaehlung ist Zugabe */ }
  const voll = mitTyp ? regelwerk.rules.filter((r) => r.vollstaendig && typeof r.content === 'string') : [];
  const namen = mitTyp ? (regelwerk.regel_verzeichnis.regeln ?? []) : regelwerk.rules.map((r) => r.name);
  return {
    // Nachtrag User (ausweis-fix 27977): Handoff immer mit Lese-Empfehlung.
    handoff: h ? { id: h.id, zeit: new Date(h.zeit).toISOString(), empfehlung: `Zuerst lesen: thought(action:"get", id:"${h.id}")` } : null,
    aktiver_plan: lage.aktiver_plan,
    ...(lage.aktiver_plan_hinweis ? { aktiver_plan_hinweis: lage.aktiver_plan_hinweis } : {}),
    top3: lage.top3,
    regeln: { ...(voll.length ? { voll: voll.map((r) => ({ name: r.name, content: r.content })) } : {}), namen, abruf: regelwerk.regel_verzeichnis.abruf },
    channels,
    skills_andere: skillsAndere,
  };
}

/**
 * P22-T49 (ausweis-fix 27972): fest zugewiesene Skills einer Ausweis-Identitaet nur als NAMEN + Abrufzeile:
 * werte.skills des wirksamen Profils (Typ + Override) und identitaetsgebundene Skill-Sections (scope agent).
 * null = nichts zugewiesen oder Produkt-Schalter profilverwaltung AUS (Bestand).
 */
async function skillsFuer(identityId: string, project: string): Promise<{ namen: string[]; identitaet?: string[]; abruf: string } | null> {
  const { leseProfilProduktSchalter } = await import('./agent-profil-schalter.js');
  if (!(await leseProfilProduktSchalter('profilverwaltung', project)).aktiv) return null;
  const { leseWirksamesProfil } = await import('./agent-zuschnitt.js');
  const roh: unknown = (await leseWirksamesProfil(identityId)).werte.skills;
  const namen = Array.isArray(roh)
    ? [...new Set(roh.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))] : [];
  let identitaet: string[] = [];
  try {
    identitaet = (await getPool().query<{ skill_name: string }>(
      "SELECT DISTINCT skill_name FROM agent_identitaet_skill_sections WHERE identity_id=$1 AND scope='agent' AND project=$2 ORDER BY skill_name",
      [identityId, project])).rows.map((z) => z.skill_name).filter((n) => !namen.includes(n));
  } catch { /* Skill-Sections nicht lesbar -> nur Profil-Skills */ }
  if (!namen.length && !identitaet.length) return null;
  return { namen, ...(identitaet.length ? { identitaet } : {}), abruf: 'skills(action:"get_full", skill_name:"<name>")' };
}

/**
 * P22-T53 Punkt 3 (User 19.10.2026, ausweis-fix 27995-27997): ein Profil verweist per Name auf Memories (profil.kontext.memories)
 * und per Kurz-ID auf Tasks (profil.kontext.tasks) - gesetzt am eigenen Profil (Koordinator/Main) oder durch Koordinator/User.
 * Die Anmeldung nennt sie in EINER Zeile: Art + Name/ID + kurzer Titel + Abrufweg, nie Volltext. Keine neuen Tags, keine
 * Regel-Kategorie; Regelverzeichnis anderer unveraendert. Keine Eintraege oder Schalter profilverwaltung AUS -> null (Zeile
 * entfaellt). Titel tragen nie einen Ausweis (maskiert).
 */
export async function kontextVerweiseFuer(identityId: string, project: string): Promise<string | null> {
  const { leseProfilProduktSchalter } = await import('./agent-profil-schalter.js');
  if (!(await leseProfilProduktSchalter('profilverwaltung', project)).aktiv) return null;
  const { leseWirksamesProfil } = await import('./agent-zuschnitt.js');
  const k: unknown = (await leseWirksamesProfil(identityId)).werte.kontext;
  if (!k || typeof k !== 'object' || Array.isArray(k)) return null;
  const liste = (v: unknown): string[] => (Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))].slice(0, 20) : []);
  const memNamen = liste((k as Record<string, unknown>).memories);
  const taskIds = liste((k as Record<string, unknown>).tasks);
  if (!memNamen.length && !taskIds.length) return null;
  const { neuesAusweisImTextMuster } = await import('./agent-ausweis-format.js');
  const titel = (t: string | null | undefined): string => {
    const zeile = (t ?? '').split('\n').map((z) => z.replace(/^[#>*\s-]+/, '').trim()).find((z) => z) ?? '';
    const sauber = zeile.replace(neuesAusweisImTextMuster(), '[maskiert]').replace(/"/g, "'");
    return sauber.length > 60 ? sauber.slice(0, 59) + '…' : sauber;
  };
  const teile: string[] = [];
  const abruf: string[] = [];
  if (memNamen.length) {
    const r = await getPool().query<{ name: string; content: string }>(
      'SELECT DISTINCT ON (name) name, content FROM memories WHERE project=$1 AND name=ANY($2::text[]) ORDER BY name, updated_at DESC', [project, memNamen]);
    const inhalt = new Map(r.rows.map((z) => [z.name, z.content]));
    for (const n of memNamen) teile.push(inhalt.has(n) ? `memory ${n} "${titel(inhalt.get(n))}"` : `memory ${n} (nicht gefunden)`);
    abruf.push(`memory(action:"read", project:"${project}", name:"<name>")`);
  }
  if (taskIds.length) {
    const r = await getPool().query<{ id: string; kurz: string | null; titel: string | null }>(
      `SELECT t.id::text AS id, t.task->>'kurz_id' AS kurz, t.task->>'title' AS titel FROM plan_tasks t
        WHERE t.project=$1 AND (t.id::text=ANY($2::text[]) OR t.task->>'kurz_id'=ANY($2::text[]))`, [project, taskIds]);
    for (const id of taskIds) {
      const z = r.rows.find((x) => x.id === id || x.kurz === id);
      teile.push(z ? `task ${z.kurz ?? id} "${titel(z.titel)}"` : `task ${id} (nicht gefunden)`);
    }
    abruf.push('plan(action:"get", task_id:"<id>")');
  }
  return `${teile.join('; ')} | Abruf: ${abruf.join(', ')}`;
}

/**
 * P22-T52 (User 19.10.2026, Live-Probe t115: Subagent-Anmeldung 10,5 KB): Inhalt der kurzen Anmeldung fuer Nicht-Koordinatoren
 * mit Ausweis (chat(anmelden)). Nur Channels, denen die Identitaet selbst angehoert, und eigene offene Tasks (Beteiligung bzw.
 * Legacy-Zuweisung). Keine Projekt-Uebersichten. null = Produkt-Schalter profilverwaltung im Projekt AUS -> Bestand (volles
 * Onboarding), gleiche Schaltung wie die Koordinator-Kurzform (P22-T49).
 */
async function baueAgentKurz(project: string, agentId: string, identityId: string): Promise<{ channels: string[]; eigene_tasks: string[] } | null> {
  const { leseProfilProduktSchalter } = await import('./agent-profil-schalter.js');
  if (!(await leseProfilProduktSchalter('profilverwaltung', project)).aktiv) return null;
  let channels: string[] = [];
  try {
    channels = (await getPool().query<{ name: string }>(
      `SELECT DISTINCT c.name FROM agent_identitaet_channel_mitglieder m JOIN specialist_channels c ON c.id=m.channel_id
        WHERE m.identity_id=$2 AND c.project=$1 AND c.archiviert_am IS NULL AND c.name NOT LIKE '%~archiv-%' ORDER BY c.name`,
      [project, identityId])).rows.map((z) => z.name);
  } catch { /* Channels sind Zugabe */ }
  let eigeneTasks: string[] = [];
  try {
    eigeneTasks = (await getPool().query<{ id: string; titel: string | null; status: string }>(
      `SELECT COALESCE(t.task->>'kurz_id', t.id) AS id, t.task->>'title' AS titel, COALESCE(t.task->>'status', 'todo') AS status
         FROM plan_tasks t
        WHERE t.project=$1 AND COALESCE(t.task->>'status', 'todo') <> 'done'
          AND CASE WHEN jsonb_typeof(t.task->'beteiligte')='array'
                THEN EXISTS (SELECT 1 FROM jsonb_array_elements(t.task->'beteiligte') b
                              WHERE b->>'identity_id'=$2 OR (COALESCE(b->>'identity_id', '')='' AND b->>'agent_id'=$3))
                ELSE COALESCE(t.task->>'zugewiesen_an', '')=$3 END
        ORDER BY t.updated_at DESC LIMIT 10`,
      [project, identityId, agentId])).rows.map((z) => `${z.id} (${z.status}): ${(z.titel ?? '').slice(0, 60)}`);
  } catch { /* Tasks sind Zugabe */ }
  return { channels, eigene_tasks: eigeneTasks };
}

/** P22-T43 (D5): Begruessung bei Anmeldung/Fortsetzung einer bestehenden Identitaet (kein 'neuer Agent'). */
const TEXT_FORTSETZUNG = '📋 FORTSETZUNG: Bestehende Identität, neuer Kontext – Projekt-Regeln zur Auffrischung (offene Events, Channels, ACKs und Bindungen bleiben erhalten):';
/** P22-T50: chat(anmelden) mit Ausweis = Neuanmeldung (neuer Lauf), auch nach Kontextverlust. */
const TEXT_ANMELDUNG = '📋 ANMELDUNG (Ausweis, neuer Lauf): Projekt-Regeln:';

export async function holeAgentOnboarding(e: {
  project: string; agentId: string; role?: string; serverInstanceId: string;
  explizit?: boolean; vorbereiten?: () => Promise<void>;
  /** P22-T49: nur chat(anmelden) mit Ausweis setzt das; index_stats onboarding:true liefert weiter alles. */
  koordinatorKurz?: boolean;
  /** P22-T50: chat(anmelden) mit Ausweis - jede Anmeldung ist eine Neuanmeldung (Begruessung ANMELDUNG statt FORTSETZUNG). */
  anmeldung?: boolean;
}) {
  const { project, agentId } = e;
  // P22-T50: '*' (jev abwesend: alle Projekte) ist nie ein Projekt - kein Onboarding, keine Registrierung.
  if (project === '*') return null;
  const { rolle, quelle } = rolleFuerAgent(agentId, e.role);
  // W12-B: null = Bestandsverhalten (kein Token-Agent mit Lauf, Kern AUS oder Lesefehler).
  const w12 = await w12ZustellKontext(project, agentId, !!e.explizit).catch(() => null);
  const folge = w12 && !e.explizit ? w12 : null;
  if (folge) {
    if (folge.umfang.pflichtregeln === 'keine' && !folge.umfang.profilblock) {
      await registerAgent(project, agentId, e.serverInstanceId, rolle, quelle);
      return null;
    }
  } else if (!e.explizit && await istOnboardingBekannt(project, agentId)) {
    await registerAgent(project, agentId, e.serverInstanceId, rolle, quelle);
    return null;
  }
  await e.vorbereiten?.();
  const core = await import('../index.js');
  if (rolle === 'channelverwalter') await core.ensureChannelverwalterRegel(project);
  const memories = await getOnboardingMemories(project);
  let regelwerk = baueOnboardingRegelwerk(memories, project, rolle);
  // P22-T48: Ausweis-Agent mit wirksamem Typ (Schalter profilverwaltung + typkatalog EIN) -> nur Typ-Regeln voll, Rest als Namen.
  const typ = w12 ? await typRegelnFuer(w12.identity_id, project).catch(() => null) : null;
  if (typ) regelwerk = wendeTypRegelnAn(regelwerk, memories, typ);
  const typDiag = regelwerk.regel_verzeichnis.typ_regeln;
  const regelDiagnose = typDiag?.aus_typ.length
    ? { regeln_quelle: 'typ' as const, aus_typ: typDiag.aus_typ, als_verzeichnis: typDiag.als_verzeichnis }
    : { regeln_quelle: 'rolle' as const, ...(typDiag ? { typ_ohne_regel: typDiag.fehlend } : {}) };
  // P22-T48: voll zugestellte Regeln gelten im Lauf auch als Werkzeug-Regel zugestellt (keine Doppelung an der Handlung).
  const markiereVoll = async (laufId: string, regeln: OnboardingRegel[]): Promise<void> => {
    if (!w12) return;
    const voll = regeln.filter((r) => r.vollstaendig && typeof r.content === 'string').map((r) => ({ name: r.name, content: r.content as string }));
    await markiereWerkzeugRegelnZugestellt({ identity_id: w12.identity_id, project, agent_id: agentId, lauf_id: laufId }, voll).catch(() => []);
  };
  if (folge) {
    // Folgeaufruf im Lauf: nur das Delta, keine Uebersichten (Channels/Plaene kommen mit anmelden/index_stats).
    const pflicht = folge.umfang.pflichtregeln === 'voll';
    // P22-T43 (D10): geaenderte Pflichtregel im laufenden Lauf -> nur die seit der letzten Zustellung geaenderten Regeln voll
    // (Grundsatz 'nur Neues/Geaendertes'). Laesst sich keine zuordnen (z. B. spaetere Profil-Marke), wie bisher alle.
    let pflichtRegeln = pflicht ? regelwerk.rules.filter(r => r.vollstaendig) : [];
    if (pflicht && folge.regeln_geaendert && folge.zugestellt_am) {
      const seit = new Date(folge.zugestellt_am).getTime();
      const geaendert = new Set(memories.filter(m => new Date(m.updatedAt).getTime() > seit).map(m => m.name));
      const nur = pflichtRegeln.filter(r => geaendert.has(r.name));
      if (nur.length) pflichtRegeln = nur;
    }
    const profilRoh = folge.umfang.profilblock ? await w12ProfilBlock(folge.identity_id) : null;
    const profilKompakt = profilRoh ? kompaktesProfil(profilRoh, { rolle, ohneRegeln: regelDiagnose.regeln_quelle === 'typ' }) : null;
    const profil = profilKompakt && Object.keys(profilKompakt).some((k) => k !== 'profil_revision') ? profilKompakt : null;
    const delta = {
      isFirstVisit: false, message: 'Neuer Lauf: nur noch nicht zugestellte Regeln/Profil (Zustellung je Lauf).',
      project, rolle, rolle_quelle: quelle,
      rules: pflichtRegeln,
      ...(folge.umfang.regel_verzeichnis ? { regel_verzeichnis: {
        ...regelwerk.regel_verzeichnis,
        regeln: regelwerk.regel_verzeichnis.regeln ?? regelwerk.rules.filter(r => !r.vollstaendig).map(r => r.name) } } : {}),
      ...(profil ? { profil } : {}),
      neuinstanz_hinweis: TEXT_NEUINSTANZ,
      zustellung: { ...zustellAnzeige(folge.umfang), lauf_id: folge.lauf_id, ...regelDiagnose },
    };
    if (!pflicht && !profil) {
      // P22-T50: Profil ohne Inhalt (nur Revision) -> keine Ausgabe, aber im Lauf als zugestellt vermerken.
      if (profilRoh) await markiereZugestellt(folge.lauf_id, { profil_revision: profilRoh.profil_revision }).catch(() => undefined);
      await registerAgent(project, agentId, e.serverInstanceId, rolle, quelle);
      return null;
    }
    const geliefert = await registerAgent(project, agentId, e.serverInstanceId, rolle, quelle, true);
    if (geliefert) {
      if (pflicht) await markiereVoll(folge.lauf_id, pflichtRegeln);
      await markiereZugestellt(folge.lauf_id, {
        ...(pflicht ? { regeln_stand: folge.regeln_stand } : {}),
        ...(profilRoh ? { profil_revision: profilRoh.profil_revision } : {}),
      }).catch(() => undefined);
    }
    return geliefert ? delta : null;
  }
  // P22-T49: zugewiesene Skills (nur Namen) fuer Ausweis-Identitaeten im expliziten Onboarding.
  const skills = w12 ? await skillsFuer(w12.identity_id, project).catch(() => null) : null;
  // P22-T53 (3): per Name im Profil verwiesene Memories/Tasks als EINE Zeile (ohne Volltext).
  const kontextVerweise = w12 ? await kontextVerweiseFuer(w12.identity_id, project).catch(() => null) : null;
  // P22-T49: Koordinator mit Ausweis bei chat(anmelden) -> kurze Ausgabe (Handoff, aktiver Plan, Top 3, Regelnamen).
  if (e.koordinatorKurz && e.explizit && w12 && rolle === 'koordinator') {
    const kurz = await baueKoordinatorKurz(project, agentId, w12.identity_id, regelwerk, regelDiagnose.regeln_quelle === 'typ').catch(() => null);
    if (kurz) {
      // P22-T50: ohne fortsetzung-Block kommt der Profilblock (kompakt, einmal je Lauf) hier.
      const profilErg = await profilTeilFuer(w12.principal, rolle, regelDiagnose.regeln_quelle === 'typ');
      const block = {
        isFirstVisit: !w12.bestehend,
        message: '📋 KOORDINATOR (Ausweis, kurz): Handoff, aktiver Plan, Top 3, Regelnamen. Volles Onboarding: admin(action:"index_stats", onboarding:true).',
        project, rolle, rolle_quelle: quelle,
        ...(kurz.handoff ? { handoff: kurz.handoff } : {}),
        // Nachtrag 27979: abgeschlossener aktiver Plan -> statt aktiver_plan nur die Aktivieren-Zeile.
        ...(kurz.aktiver_plan_hinweis ? { aktiver_plan_hinweis: kurz.aktiver_plan_hinweis } : { aktiver_plan: kurz.aktiver_plan }),
        ...(kurz.top3.length ? { top3: kurz.top3 } : {}),
        regeln: kurz.regeln,
        ...(kurz.channels ? { channels: kurz.channels } : {}),
        ...profilErg.teil,
        ...(skills ? { skills } : {}), ...(kontextVerweise ? { kontext_verweise: kontextVerweise } : {}),
        ...(kurz.skills_andere.length ? { skills_andere: kurz.skills_andere } : {}),
        statistik_abruf: 'Statistiken, Jev, Erklaerungsfaelle, Entscheidungs-Durchsicht: admin(action:"index_stats", onboarding:true)',
        neuinstanz_hinweis: TEXT_NEUINSTANZ,
        zustellung: { ...zustellAnzeige(w12.umfang), profilblock: profilErg.zugestellt, lauf_id: w12.lauf_id, ...regelDiagnose, koordinator_kurz: true },
      };
      const geliefert = await registerAgent(project, agentId, e.serverInstanceId, rolle, quelle, e.explizit);
      if (geliefert) {
        if (regelDiagnose.regeln_quelle === 'typ') await markiereVoll(w12.lauf_id, regelwerk.rules);
        await markiereZugestellt(w12.lauf_id, { regeln_stand: w12.regeln_stand }).catch(() => undefined);
      }
      return geliefert ? block : null;
    }
  }
  // P22-T52: Nicht-Koordinator mit Ausweis bei chat(anmelden) -> kurz: rules (Typ-Regeln voll), Regelnamen + eine Abrufzeile,
  // eigene Channels, Profil/gebundene und eigene Tasks. Weg: fremde Channels, Planliste, task_suche_hinweis, zustellung,
  // typ_regeln, rolle_hinweis, Wissensnamen, langer Verzeichnis-Hinweis. Schalter profilverwaltung AUS -> Bestand.
  if (e.koordinatorKurz && e.explizit && w12 && rolle !== 'koordinator') {
    const kurz = await baueAgentKurz(project, agentId, w12.identity_id).catch(() => null);
    if (kurz) {
      const profilErg = await profilTeilFuer(w12.principal, rolle, regelDiagnose.regeln_quelle === 'typ');
      const faelle = await core.erklaerungsFaelleZeile({ project, agent_id: agentId, koordinator: false }).catch(() => null);
      const namen = regelwerk.regel_verzeichnis.regeln ?? [];
      const block = {
        isFirstVisit: !w12.bestehend,
        message: w12.bestehend ? TEXT_ANMELDUNG : '📋 WILLKOMMEN! Als neuer Agent beachte bitte folgende Projekt-Regeln:',
        project, rolle,
        rules: regelwerk.rules,
        regel_verzeichnis: { ...(namen.length ? { regeln: namen } : {}), abruf: regelwerk.regel_verzeichnis.abruf },
        ...(kurz.channels.length ? { channels: kurz.channels } : {}),
        ...profilErg.teil,
        ...(kurz.eigene_tasks.length ? { eigene_tasks: kurz.eigene_tasks } : {}),
        ...(skills ? { skills } : {}), ...(kontextVerweise ? { kontext_verweise: kontextVerweise } : {}),
        ...(faelle ? { erklaerung_faelle: faelle } : {}),
        neuinstanz_hinweis: TEXT_NEUINSTANZ,
      };
      const geliefert = await registerAgent(project, agentId, e.serverInstanceId, rolle, quelle, e.explizit);
      if (geliefert) {
        await markiereVoll(w12.lauf_id, regelwerk.rules);
        await markiereZugestellt(w12.lauf_id, { regeln_stand: w12.regeln_stand }).catch(() => undefined);
      }
      return geliefert ? block : null;
    }
  }
  const { rules, regel_verzeichnis } = regelwerk;
  const volltext = baueRegelAbrufHinweis(project, rules.filter(r => !r.vollstaendig).length);
  const koordinator = rolle === 'koordinator';
  const channels = await core.baueChannelUebersicht(project, koordinator);
  const jev = await core.baueAbwesenheitsHinweis(project);
  const faelle = await core.erklaerungsFaelleZeile({ project, agent_id: agentId, koordinator });
  const durchsicht = await core.entscheidungsDurchsichtZeile({ project, koordinator });
  const plaene = await core.planUebersicht(project);
  // P22-T43 (D2): Profilblock genau einmal je Lauf. Hat der Lauf ihn (in aktueller Revision) noch nicht, kommt er HIER samt
  // Profil-Channels und wird als zugestellt markiert (baueFortsetzungsErgaenzung prueft den Laufstand selbst).
  // P22-T50: auch bei chat(anmelden) hier (kein fortsetzung-Block mehr), kompakt ohne Leerfelder, dazu gebundene Tasks.
  const profilErg = w12 ? await profilTeilFuer(w12.principal, rolle, regelDiagnose.regeln_quelle === 'typ') : { teil: {}, zugestellt: false };
  // P22-T43 (D5): Anmeldung/Fortsetzung einer BESTEHENDEN Identitaet ist kein 'neuer Agent'.
  const fortsetzung = !!w12?.bestehend;
  // P22-T50: chat(anmelden) mit Ausweis ist immer eine Neuanmeldung (auch nach Kontextverlust): bestehende Identitaet
  // -> ANMELDUNG statt FORTSETZUNG; eine ganz neue Identitaet behaelt die Begruessung.
  const begruessung = e.anmeldung && w12 && fortsetzung ? TEXT_ANMELDUNG : fortsetzung ? TEXT_FORTSETZUNG : '📋 WILLKOMMEN! Als neuer Agent beachte bitte folgende Projekt-Regeln:';
  const block = {
    // P10-T78: Begruessung wieder auf allen Strecken (REST verlor sie mit P7-T40; stdio ergaenzt sie in server.ts).
    isFirstVisit: !fortsetzung,
    message: begruessung, project, rolle, rolle_quelle: quelle,
    rolle_hinweis: rollenQuelleKlartext(rolle, quelle, e.role),
    rules, regel_verzeichnis,
    task_suche_hinweis: 'Vor dem Anlegen einer Task zuerst search(tasks), search(plans) oder plan(search, art:tasks|plans) mit alle:true ohne Statusfilter. Pins zählen Thoughts/Dateiversionen; mit_verknuepfungen:true liefert jüngste IDs. aehnlich beim Anlegen ist nur ein Hinweis.',
    ...(volltext ? { volltext_hinweis: volltext } : {}),
    ...(channels ? { channels } : {}),
    ...(jev ? { jev_hinweis: jev } : {}),
    ...(faelle ? { erklaerung_faelle: faelle } : {}),
    ...(durchsicht ? { entscheidungen_durchsicht: durchsicht } : {}),
    ...(plaene.length ? { plaene } : {}),
    // W12-B: nur fuer Token-Agenten mit Lauf bei Kern EIN (sonst Bestandsform unveraendert).
    ...profilErg.teil,
    ...(skills ? { skills } : {}), ...(kontextVerweise ? { kontext_verweise: kontextVerweise } : {}),
    ...(w12 ? { neuinstanz_hinweis: TEXT_NEUINSTANZ, zustellung: { ...zustellAnzeige(w12.umfang), profilblock: profilErg.zugestellt, lauf_id: w12.lauf_id, ...regelDiagnose } } : {}),
  };
  const geliefert = await registerAgent(project, agentId, e.serverInstanceId, rolle, quelle, e.explizit);
  if (geliefert && w12) {
    await markiereVoll(w12.lauf_id, rules);
    await markiereZugestellt(w12.lauf_id, { regeln_stand: w12.regeln_stand }).catch(() => undefined);
  }
  return geliefert ? block : null;
}
