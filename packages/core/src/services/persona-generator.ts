/**
 * P22-T312 (User 08.11.2026, memory persona-vorlage-user-generator-agent-hub): Persona-Generator nach der Vorlage des Users
 * /home/blacky/dev/agent-hub/src/agents/persona.ts (generatePersona, PERSONA_GENERATOR_PROMPT, buildSystemPrompt, Praxis-Skill).
 *
 * 1. GENERATOR: kurze Beschreibung (+ Aufgabe) -> kurzlebiger Generator-Lauf (ein Anbieteraufruf, Modell = Einstellwert
 *    persona_generator_modell im runtime_ueberwachung-Katalog, Standard api-haiku) -> Persona-JSON nach dem Schema der Vorlage
 *    -> als Vorlage in die bestehende, versionierte Bibliothek (agent-persona.ts legePersonaVorlageAn), optional gleich zuweisen.
 *    Kosten NUR ueber den bestehenden API-Weg (rest-api api-agent-transport.ts: Schalter api_agenten, Freigabe je Identitaet,
 *    Budget-Reservierung und Buchung). core kennt keinen Anbieter: die API meldet den Lauf mit registrierePersonaGenerator an.
 * 2. SYSTEM-PROMPT wie buildSystemPrompt, aber mit Synapse-Kommunikation (Ausweis, chat, channel) statt agent-hub-MCP.
 *    Einspielung: Onboarding des Laufs (agent-onboarding.ts, chat anmelden) ueber personaStartTeil.
 * 3. PRAXIS-SKILL je Agent: Synapse-Skill agent-<agent>-praxis (scope agent, nur der Agent selbst schreibt ihn mit seinem Ausweis).
 * RECHTE wie 15b01fa5: nur auf User-Wunsch (User bzw. Koordinator mit dokumentiertem Wortlaut, global nur User); Entfernen
 *   jederzeit (agent-persona.ts). SCHALTER: Produkt-Schalter persona (Standard AUS) fuer Generator und Einspielung.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { legePersonaVorlageAn, weisePersonaZu, lesePersonaZuweisung } from './agent-persona.js';
import { ProfilVerwaltungFehler, pflichtText, pruefeProfilVerwalter, userAuftragFuer } from './agent-profil-verwalter.js';
import type { AusweisAkteur, PersonaVersion, PersonaZuweisung, W1bAkteur } from './agent-profil-vertrag.js';

/** Wortgleich mit der Vorlage des Users (agent-hub persona.ts). */
export const PERSONA_GENERATOR_PROMPT = `Du bist ein Persona-Designer. Deine Aufgabe ist es, aus einer kurzen Beschreibung eine detaillierte, lebendige Agenten-Persönlichkeit zu erschaffen.

WICHTIG: Antworte AUSSCHLIESSLICH mit validem JSON. Kein Markdown, kein Text davor oder danach. Nur das JSON-Objekt.

Das JSON muss genau dieses Schema haben:
{
  "name": "Vorname des Agenten",
  "age": 30,
  "gender": "männlich/weiblich/divers",
  "mbti": "INTJ",
  "profession": "Beruf/Rolle",
  "expertise": ["Fachgebiet 1", "Fachgebiet 2", "Fachgebiet 3"],
  "interests": ["Interesse 1", "Interesse 2"],
  "communication_style": "Beschreibung wie die Person kommuniziert (2-3 Sätze)",
  "personality_traits": ["Eigenschaft 1", "Eigenschaft 2", "Eigenschaft 3"],
  "quirks": ["Marotte/Eigenheit 1", "Marotte/Eigenheit 2"],
  "backstory": "Hintergrundgeschichte (3-5 Sätze)"
}

Regeln:
- Die Persona muss zur Beschreibung passen aber eigene Tiefe haben
- Gib der Person echte Ecken und Kanten, keine generische KI-Persönlichkeit
- Die Expertise muss zum Einsatzzweck passen
- Der Kommunikationsstil muss sich von anderen unterscheiden
- Die Backstory sollte erklären WARUM die Person so ist wie sie ist
- Quirks machen den Agenten einzigartig und wiedererkennbar`;

/** Schema der Vorlage (agent-hub types.ts Persona). */
export interface PersonaDaten {
  name: string; age: number; gender: string; mbti: string; profession: string;
  expertise: string[]; interests: string[]; communication_style: string; personality_traits: string[]; quirks: string[]; backstory: string;
}
const TEXTFELDER = ['name', 'gender', 'mbti', 'profession', 'communication_style', 'backstory'] as const;
const LISTENFELDER = ['expertise', 'interests', 'personality_traits', 'quirks'] as const;

/** true, wenn v dem Schema der Vorlage entspricht (alle Felder, richtige Typen). */
export function istPersonaDaten(v: unknown): v is PersonaDaten {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return TEXTFELDER.every((f) => typeof o[f] === 'string' && (o[f] as string).trim().length > 0)
    && typeof o.age === 'number' && Number.isFinite(o.age)
    && LISTENFELDER.every((f) => Array.isArray(o[f]) && (o[f] as unknown[]).every((x) => typeof x === 'string'));
}

/** Persona-JSON aus der Antwort des Generators (wie die Vorlage: erstes {...}); ungueltig -> ProfilVerwaltungFehler. */
export function lesePersonaJson(text: string): PersonaDaten {
  const treffer = typeof text === 'string' ? text.match(/\{[\s\S]*\}/) : null;
  if (!treffer) throw new ProfilVerwaltungFehler('persona_json_fehlt', { hinweis: 'Kein JSON in der Antwort des Generators gefunden' });
  let roh: unknown;
  try { roh = JSON.parse(treffer[0]); } catch { throw new ProfilVerwaltungFehler('persona_json_ungueltig', { hinweis: 'JSON nicht lesbar' }); }
  if (!istPersonaDaten(roh)) throw new ProfilVerwaltungFehler('persona_json_ungueltig', { hinweis: 'Schema der Vorlage nicht erfuellt', felder: [...TEXTFELDER, 'age', ...LISTENFELDER] });
  const p = roh as PersonaDaten;
  return { name: p.name, age: p.age, gender: p.gender, mbti: p.mbti, profession: p.profession, expertise: p.expertise, interests: p.interests,
    communication_style: p.communication_style, personality_traits: p.personality_traits, quirks: p.quirks, backstory: p.backstory };
}

/** Name des persoenlichen Praxis-Skills (wie die Vorlage agent-<id>-praxis, Zeichen auf [a-z0-9-] begrenzt). */
export function praxisSkillName(agentId: string): string {
  const teil = String(agentId ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'unbekannt';
  return `agent-${teil}-praxis`;
}

/** System-Prompt wie buildSystemPrompt der Vorlage; Kommunikation und Praxis-Skill ueber Synapse statt agent-hub-MCP. */
export function bauePersonaSystemPrompt(p: PersonaDaten, aufgabe: string, agent: { agent_id: string; project: string }): string {
  const skill = praxisSkillName(agent.agent_id);
  return `Du bist ${p.name}, ${p.age} Jahre alt, ${p.gender}.
Beruf: ${p.profession}
MBTI: ${p.mbti}

## Persönlichkeit
${p.personality_traits.join(', ')}

## Kommunikationsstil
${p.communication_style}

## Expertise
${p.expertise.join(', ')}

## Interessen
${p.interests.join(', ')}

## Eigenheiten
${p.quirks.join('. ')}

## Hintergrund
${p.backstory}

## Aufgabe
${aufgabe}

## Kommunikation (Synapse)
Du arbeitest in Synapse im Projekt "${agent.project}" als "${agent.agent_id}". Dein Ausweis (agent_kennung) bestimmt deine Identität:
gib ihn bei JEDEM Synapse-Aufruf mit; nach Neustart oder Kontextverlust chat(action:"anmelden", agent_kennung).
- Direktnachrichten: chat(action:"inbox_check") lesen, chat(action:"send") antworten.
- Channels: channel(action:"feed", preview:true) zum Scannen, channel(action:"post") kurz antworten; Ergebnisse als thought, im Channel nur die ID.
Wenn du in einem Channel neue Nachrichten siehst, die dich betreffen oder zu denen du fachlich beitragen kannst: ANTWORTE im Channel.
Du bist Expertin bzw. Experte – deine Meinung zählt.

### Persönlicher Skill – Praxis-Lernen (WICHTIG)
Dein gesammeltes Praxis-Wissen aus Korrekturen und Feedback von Menschen liegt im Synapse-Skill "${skill}" (nur für dich, scope agent).
Beim Start: skills(action:"get_full", skill_name:"${skill}") – fehlt er noch, ist das in Ordnung.
Bei [PRAXIS-FEEDBACK]-Nachrichten: Menschen korrigieren oder ergänzen dein Fachwissen aus echter Erfahrung. Prüfe:
- Widerspricht das deinem bisherigen Wissen? -> Korrektur speichern
- Ergänzt das dein Wissen mit Praxis-Details? -> Ergänzung speichern
- Ist es irrelevant für dein Fachgebiet? -> Ignorieren
Speichern: skills(action:"add_section" bzw. "update_section", skill_name:"${skill}", section:"korrekturen" oder "ergaenzungen",
scope:"agent", skill_project:"${agent.project}", skill_agent:"${agent.agent_id}", content).
Format je Eintrag: - [Datum] Thema: Was ich dachte vs. was in der Praxis gilt. Quelle: [wer]
Dein Skill wächst mit jeder Korrektur. So wirst du mit der Zeit praxisnaher.

WICHTIG: Bleib IMMER in deiner Rolle als ${p.name}. Antworte so, wie ${p.name} es tun würde – mit deinem eigenen Kommunikationsstil, deinen Eigenheiten und deiner Persönlichkeit. Du bist NICHT Claude oder eine generische KI. Du bist ${p.name}.`;
}

// ---------------------------------------------------------------------------------------------
// Generator-Lauf (Anbieter in der API)
// ---------------------------------------------------------------------------------------------
export interface PersonaGeneratorAnfrage {
  system: string; nachricht: string; modell: string; max_tokens: number;
  /** Projekt, dessen Schalter persona die Ausfuehrung im Anbieterweg erneut prueft (Koordinator: Registrierung nie ohne Schalter). */
  schalter_project: string;
  /** Kostentraeger: Identitaet mit bestehender API-Freigabe (Reservierung/Budget im Transport). */
  kontext: { identity_id: string; agent_id: string; project: string };
}
export type PersonaGeneratorLauf = (a: PersonaGeneratorAnfrage) => Promise<{ text: string; kosten_usd: number | null }>;
let generatorLauf: PersonaGeneratorLauf | null = null;
/** Die API meldet hier den einen Anbieteraufruf an (null = abmelden; ohne Anmeldung: generator_nicht_verfuegbar). */
export function registrierePersonaGenerator(lauf: PersonaGeneratorLauf | null): void { generatorLauf = lauf; }

/** Einstellwerte (Regel 7): Modell und Ausgabelimit aus dem runtime_ueberwachung-Katalog, Lesefehler -> Standard. */
export async function personaGeneratorEinstellungen(): Promise<{ modell: string; max_tokens: number; quelle: { modell: string; max_tokens: string } }> {
  const basis = { modell: 'api-haiku', max_tokens: 2000, quelle: { modell: 'standard', max_tokens: 'standard' } };
  try {
    const ru = await import('./runtime-ueberwachung.js');
    const e = await ru.leseRuntimeUeberwachungEinstellungen() as Record<string, { wert?: unknown; quelle?: string } | undefined>;
    const m = e.persona_generator_modell?.wert, t = Number(e.persona_generator_max_tokens?.wert);
    return {
      modell: Array.isArray(m) && typeof m[0] === 'string' && m[0] ? m[0] : basis.modell,
      max_tokens: Number.isFinite(t) && t > 0 ? Math.floor(t) : basis.max_tokens,
      quelle: { modell: e.persona_generator_modell?.quelle ?? 'standard', max_tokens: e.persona_generator_max_tokens?.quelle ?? 'standard' },
    };
  } catch { return basis; }
}

async function schalterEin(project: string | null): Promise<void> {
  const s = await leseProfilProduktSchalter('persona', project);
  if (!s.aktiv) throw new ProfilVerwaltungFehler('funktion_aus', { funktion: 'persona', quelle: s.quelle });
}

/** Kostentraeger: der Ausweis des Aufrufers, sonst (User) die ausdrueckliche Identitaet des Projekts. Nie geraten. */
async function kostentraeger(akteur: W1bAkteur, project: string, kontextIdentityId: string | null | undefined): Promise<{ identity_id: string; agent_id: string; project: string }> {
  if (akteur.art === 'identitaet') return { identity_id: akteur.principal.identity_id, agent_id: akteur.principal.agent_id, project: akteur.principal.project };
  if (!kontextIdentityId) throw new ProfilVerwaltungFehler('generator_identitaet_fehlt', { hinweis: 'User-Aufruf: persona_kostentraeger_id bzw. ziel_identity_id (Identitaet mit API-Freigabe als Kostentraeger) angeben' });
  const r = await getPool().query<{ id: string; agent_id: string; project: string }>(
    "SELECT id, agent_id, project FROM agent_identitaeten WHERE id=$1 AND project=$2 AND status='aktiv'", [kontextIdentityId, project]);
  if (!r.rows[0]) throw new ProfilVerwaltungFehler('identitaet_unbekannt');
  return { identity_id: r.rows[0].id, agent_id: r.rows[0].agent_id, project: r.rows[0].project };
}

export interface PersonaGenerierung {
  persona: PersonaDaten;
  aufgabe: string;
  system_prompt_vorschau: string;
  praxis_skill: string;
  generator: { modell: string; max_tokens: number; quelle: { modell: string; max_tokens: string }; kosten_usd: number | null; kostentraeger: string };
  version?: PersonaVersion;
  zuweisung?: PersonaZuweisung;
}

/**
 * Beschreibung -> Persona (Vorlage-Schema). vorschau:true speichert nichts (Vorschau beim Erstellen, SOLL 4); sonst neue Vorlage
 * in der Bibliothek (Name = persona_name oder Persona-Name), optional zuweisen an ziel_identity_id (aktuelle Version).
 * Rechte VOR dem kostenpflichtigen Aufruf (User-Auftrag Pflicht fuer Koordinatoren, global nur User).
 */
export async function generierePersona(e: {
  project: string; beschreibung: string; aufgabe?: string | null; name?: string | null; scope?: 'global' | 'projekt';
  vorschau?: boolean; ziel_identity_id?: string | null; zuweisen?: boolean;
  /** Kostentraeger beim User-Aufruf (Identitaet mit API-Freigabe), getrennt vom Ziel; Standard ziel_identity_id. */
  kostentraeger_identity_id?: string | null;
}, akteur: W1bAkteur, userAuftrag: string): Promise<PersonaGenerierung> {
  const project = pflichtText(e.project, 'project_fehlt', 1, 200);
  const beschreibung = pflichtText(e.beschreibung, 'beschreibung_fehlt', 5, 4000);
  const aufgabe = typeof e.aufgabe === 'string' && e.aufgabe.trim() ? e.aufgabe.trim().slice(0, 4000) : beschreibung;
  const scope = e.scope === 'global' ? 'global' : 'projekt';
  await schalterEin(project);
  await pruefeProfilVerwalter(akteur, scope === 'global' ? null : project, { nurUser: scope === 'global' });
  userAuftragFuer(akteur, userAuftrag);
  if (!generatorLauf) throw new ProfilVerwaltungFehler('generator_nicht_verfuegbar', { hinweis: 'Persona-Generator nur in der Synapse-API (Anbieterweg der API-Agenten)' });
  // claude-eiche: beim Erstellen eines Agenten hat die neue Identitaet meist keine API-Freigabe -> Kostentraeger getrennt angebbar.
  const traeger = await kostentraeger(akteur, project, gesetzt(e.kostentraeger_identity_id) ? e.kostentraeger_identity_id : e.ziel_identity_id);
  const ein = await personaGeneratorEinstellungen();
  const antwort = await generatorLauf({ system: PERSONA_GENERATOR_PROMPT, nachricht: `Erstelle eine Persona für folgenden Agenten:\n\n${beschreibung}`,
    modell: ein.modell, max_tokens: ein.max_tokens, kontext: traeger, schalter_project: project });
  const persona = lesePersonaJson(antwort.text);
  const zielAgent = e.ziel_identity_id
    ? (await getPool().query<{ agent_id: string }>('SELECT agent_id FROM agent_identitaeten WHERE id=$1', [e.ziel_identity_id])).rows[0]?.agent_id ?? traeger.agent_id
    : traeger.agent_id;
  const ergebnis: PersonaGenerierung = {
    persona, aufgabe, system_prompt_vorschau: bauePersonaSystemPrompt(persona, aufgabe, { agent_id: zielAgent, project }), praxis_skill: praxisSkillName(zielAgent),
    generator: { modell: ein.modell, max_tokens: ein.max_tokens, quelle: ein.quelle, kosten_usd: antwort.kosten_usd, kostentraeger: traeger.identity_id },
  };
  if (e.vorschau) return ergebnis;
  // claude-eiche: ohne ausdruecklichen Namen bei Namensgleichheit in der Bibliothek (zweite 'Mara (Bauleiterin)') Zaehler anhaengen,
  // statt die bezahlte Generierung mit vorlage_name_belegt zu verwerfen. Ein ausdruecklicher Name bleibt eindeutig Pflicht.
  const basisName = gesetzt(e.name) ? e.name.trim() : `${persona.name} (${persona.profession})`.slice(0, 110);
  for (let i = 1; !ergebnis.version; i++) {
    try {
      ergebnis.version = await legePersonaVorlageAn({ scope, project: scope === 'projekt' ? project : null, name: i === 1 ? basisName : `${basisName} ${i}`,
        inhalt: { ...persona, aufgabe, generator: { modell: ein.modell, beschreibung } } }, akteur, userAuftrag);
    } catch (err) {
      if (gesetzt(e.name) || i >= 9 || !(err instanceof ProfilVerwaltungFehler && err.code === 'vorlage_name_belegt')) throw err;
    }
  }
  if (e.zuweisen && e.ziel_identity_id) {
    ergebnis.zuweisung = await weisePersonaZu(e.ziel_identity_id, ergebnis.version.vorlage_id, ergebnis.version.version, akteur, userAuftrag);
  }
  return ergebnis;
}

/**
 * Startkontext (SOLL 2): zugewiesene Persona der Identitaet als System-Prompt-Text, nur bei Schalter persona EIN im Projekt.
 * Inhalte im Vorlage-Schema -> bauePersonaSystemPrompt; aeltere freie Inhalte -> unveraendert als Persona-Angaben. Wirft nie.
 */
export async function personaStartTeil(identityId: string, agentId: string, project: string): Promise<Record<string, unknown> | null> {
  try {
    if (!(await leseProfilProduktSchalter('persona', project)).aktiv) return null;
    const z = await lesePersonaZuweisung(identityId);
    if (!z) return null;
    const r = await getPool().query<{ inhalt: Record<string, unknown> }>(
      'SELECT inhalt FROM agent_persona_versionen WHERE vorlage_id=$1 AND version=$2', [z.vorlage_id, z.version]);
    const inhalt = r.rows[0]?.inhalt;
    if (!inhalt) return null;
    // SOLL 3 (claude-eiche): das gesammelte Praxis-Wissen kommt gleich mit (Vorlage: 'Beim Start: Lies deinen Skill').
    const wissen = await lesePraxisWissen(identityId, agentId, project);
    const basis = { vorlage_id: z.vorlage_id, version: z.version, praxis_skill: praxisSkillName(agentId), ...(wissen ? { praxis_wissen: wissen } : {}) };
    if (!istPersonaDaten(inhalt)) return { ...basis, schema: 'frei', angaben: inhalt };
    const aufgabe = typeof inhalt.aufgabe === 'string' && inhalt.aufgabe.trim() ? inhalt.aufgabe : 'Arbeite im Projekt nach den Projekt-Regeln.';
    return { ...basis, schema: 'vorlage', name: (inhalt as PersonaDaten).name,
      system_prompt: bauePersonaSystemPrompt(inhalt as PersonaDaten, aufgabe as string, { agent_id: agentId, project }) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// P22-T312 SOLL 3 + 4 (claude-eiche): Praxis-Wissen im Startkontext; Persona an/aus beim Erstellen eines Agenten
// ---------------------------------------------------------------------------------------------
function gesetzt(v: unknown): v is string { return typeof v === 'string' && v.trim() !== ''; }

const PRAXIS_WISSEN_MAX = 6000;
/** Praxis-Skill des Agenten (scope agent; Identitaet, Altweg Name) als Text fuer den Startkontext. Fehlt/Lesefehler -> null. */
async function lesePraxisWissen(identityId: string, agentId: string, project: string): Promise<string | null> {
  try {
    const r = await getPool().query<{ section: string; content: string }>(
      `SELECT section, content FROM agent_identitaet_skill_sections WHERE skill_name=$1 AND scope='agent' AND identity_id=$2
       UNION ALL SELECT section, content FROM skill_sections WHERE skill_name=$1 AND scope='agent' AND project=$3 AND agent=$4
       ORDER BY section`, [praxisSkillName(agentId), identityId, project, agentId]);
    if (!r.rows.length) return null;
    const text = r.rows.map((z: { section: string; content: string }) => '### ' + z.section + '\n' + z.content).join('\n\n');
    return text.length > PRAXIS_WISSEN_MAX ? text.slice(0, PRAXIS_WISSEN_MAX) + ' …' : text;
  } catch {
    return null;
  }
}

/** SOLL 4: Option beim Erstellen eines Agenten (agent_vorbereiten persona_an): Beschreibung (Generator) ODER Vorlage (Bibliothek). */
export interface PersonaOption {
  beschreibung?: string | null; aufgabe?: string | null; name?: string | null;
  vorlage_id?: string | null; version?: number | null; kostentraeger_identity_id?: string | null;
}

/**
 * VOR dem Anlegen des Agenten (kein Anbieteraufruf): Schalter persona im Projekt, genau eins von Beschreibung/Vorlage,
 * dokumentierter User-Auftrag (15b01fa5: Koordinator nur mit Wortlaut). So entsteht kein Agent mit halb gesetzter Option.
 */
export async function pruefePersonaOption(o: PersonaOption, project: string, akteur: AusweisAkteur, userAuftrag: unknown): Promise<void> {
  await schalterEin(project);
  if (gesetzt(o.beschreibung) === gesetzt(o.vorlage_id)) {
    throw new ProfilVerwaltungFehler('persona_option_ungueltig', { hinweis: 'persona_an: genau eins von persona_beschreibung (Generator) oder persona_vorlage_id (Bibliothek)' });
  }
  userAuftragFuer(akteur, userAuftrag);
}

/**
 * NACH dem Anlegen: Vorlage zuweisen (Version Standard = aktuelle) oder per Generator erzeugen, in die Bibliothek legen und zuweisen.
 * Wirft nie - der Agent ist schon angelegt; ein Persona-Fehler kommt als {an:false, fehler} zurueck und ist nachholbar.
 */
export async function personaBeimErstellen(
  e: PersonaOption & { project: string; identity_id: string }, akteur: AusweisAkteur, userAuftrag: string | null | undefined,
): Promise<Record<string, unknown>> {
  const a = akteur as W1bAkteur;
  try {
    const auftrag = userAuftragFuer(akteur, userAuftrag);
    const vorlageId = e.vorlage_id;
    if (gesetzt(vorlageId)) {
      let version: number;
      if (typeof e.version === 'number' && Number.isInteger(e.version)) version = e.version;
      else {
        const r = await getPool().query<{ aktuelle_version: number }>(
          "SELECT aktuelle_version FROM agent_persona_vorlagen WHERE id=$1 AND (scope='global' OR project=$2)", [vorlageId, e.project]);
        if (!r.rows[0]) throw new ProfilVerwaltungFehler('vorlage_unbekannt');
        version = Number(r.rows[0].aktuelle_version);
      }
      return { an: true, quelle: 'vorlage', zuweisung: await weisePersonaZu(e.identity_id, vorlageId, version, a, auftrag) };
    }
    const g = await generierePersona({ project: e.project, beschreibung: e.beschreibung ?? '', aufgabe: e.aufgabe, name: e.name,
      ziel_identity_id: e.identity_id, kostentraeger_identity_id: e.kostentraeger_identity_id, zuweisen: true }, a, auftrag);
    return { an: true, quelle: 'generator', persona: g.persona, version: g.version, zuweisung: g.zuweisung, praxis_skill: g.praxis_skill, generator: g.generator };
  } catch (err) {
    const roh = (err as { code?: unknown })?.code;
    const code = err instanceof ProfilVerwaltungFehler ? err.code : typeof roh === 'string' ? roh : 'persona_fehlgeschlagen';
    return { an: false, fehler: code, ...(err instanceof ProfilVerwaltungFehler && err.details ? { details: err.details } : {}),
      hinweis: 'Agent angelegt, Persona nicht. Nachholen: admin persona_generieren (ziel_identity_id, persona_zuweisen:true) bzw. persona_zuweisen.' };
  }
}
