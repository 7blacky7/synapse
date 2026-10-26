/**
 * P22-T176 (User 26.10.2026 ~01:30): Anthropic-API-Key des API-Agenten in der Web-UI hinterlegen, ersetzen, entfernen.
 * Nur der User setzt; der Wert verlaesst den Server nie (keine Antwort, kein Log, kein Audit, kein Verlauf). Sichtbar sind nur
 * vorhanden ja/nein, Quelle (Web-UI|Env), gesetzt am und die letzten 4 Zeichen.
 * SPEICHER (Schema 160): api_agent_schluessel, genau eine Zeile (id 1): Chiffre + schluessel_id + letzte 4 Zeichen + Grund.
 * VERSCHLUESSELUNG: bestehender Server-Tresor agent-token-tresor.ts (AES-256-GCM, Schluessel nur aus Env
 *   SYNAPSE_AGENT_TOKEN_SCHLUESSEL, kein Klartext-Fallback). AAD bindet die Chiffre an 'server-geheimnis:anthropic_api_key'.
 * SCHALTER: Produkt-Schalter global funktion 'hauptagent_api_key_webui' (agent_profil_schalter, Standard AUS, setzen nur User).
 *   AUS = Altverhalten: nur Env SYNAPSE_ANTHROPIC_API_KEY, Hinterlegen abgelehnt (funktion_aus), eine gespeicherte Zeile bleibt unbenutzt.
 * VORRANG (Schalter EIN): Web-UI-Key vor Env; Entfernen faellt auf Env zurueck. Ist die Chiffre nicht lesbar (Tresorschluessel
 *   fehlt oder gewechselt), gilt Env und der Fehler steht im Stand (fehler, debug).
 * Den Key braucht nur der Transport (rest-api agent-api.ts: Anbieter-Aufruf und 'Key testen') ueber aktuellerApiKey().
 * P22-T179 Nachtrag (Koordinator 26.10.2026 nach Live-Probe 04dd2649): optionale Workspace-ID (Env SYNAPSE_ANTHROPIC_WORKSPACE_ID)
 *   als Header anthropic-workspace-id an JEDEM Anthropic-Aufruf (anthropicKopfzeilen); leer = wie bisher. Sichtbar nur ja/nein.
 */
import { getPool } from '../db/client.js';
import { verschluesseleAgentToken, entschluesseleAgentToken, tokenSchluesselStand, TokenTresorFehler } from './agent-token-tresor.js';
import { ProfilVerwaltungFehler, pflichtText } from './agent-profil-verwalter.js';
import type { AusweisAkteur } from './agent-profil-vertrag.js';

export const API_KEY_WEBUI_FUNKTION = 'hauptagent_api_key_webui' as const;
export const API_KEY_ENV = 'SYNAPSE_ANTHROPIC_API_KEY' as const;
/** Anthropic-Keys: 'sk-ant-' + Buchstaben, Ziffern, '-' und '_' (Leerzeichen/Zeilenumbrueche beim Einfuegen werden abgeschnitten). */
export const API_KEY_FORM = /^sk-ant-[A-Za-z0-9_-]{10,500}$/;
const TRESOR_ID = 'server-geheimnis:anthropic_api_key';

/**
 * P22-T179 Nachtrag: Ein Key ohne Workspace-Zuordnung wird von Anthropic nur mit Header anthropic-workspace-id angenommen (sonst HTTP 400
 * "not scoped to a workspace"). Env gesetzt -> Header an jedem Anthropic-Aufruf (Transport Main und Agenten, 'Key testen').
 */
export const API_WORKSPACE_ENV = 'SYNAPSE_ANTHROPIC_WORKSPACE_ID' as const;
export const API_WORKSPACE_HEADER = 'anthropic-workspace-id' as const;
export const API_WORKSPACE_HINWEIS = 'Der Anthropic-Key ist keinem Workspace zugeordnet: SYNAPSE_ANTHROPIC_WORKSPACE_ID (Workspace-ID aus der Anthropic Console) '
  + 'in der Umgebung der synapse-api setzen (secrets.env, wird beim Deploy uebernommen) oder einen Key verwenden, der einem Workspace zugeordnet ist.';

export function anthropicWorkspaceId(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env[API_WORKSPACE_ENV]?.trim();
  return v ? v : null;
}

/** Zusaetzliche Kopfzeilen fuer den Anthropic-Client (defaultHeaders); leer ohne Workspace-ID. */
export function anthropicKopfzeilen(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const id = anthropicWorkspaceId(env);
  return id ? { [API_WORKSPACE_HEADER]: id } : {};
}

/** Eindeutige Anthropic-Meldung fuer einen Key ohne Workspace (HTTP 400 invalid_request_error). */
export function istWorkspaceFehlt(text: unknown): boolean {
  return typeof text === 'string' && /not scoped to a workspace/i.test(text);
}

function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }
const letzte4 = (k: string): string => k.slice(-4);

export interface ApiKeySchalterStand {
  aktiv: boolean;
  quelle: 'standard' | 'produkt-schalter';
  gesetzt_am: string | null;
  grund: string | null;
  letzter_fehler: string | null;
}

/** Frisch je Aufruf (kein Cache). Lesefehler -> AUS mit letzter_fehler. */
export async function leseApiKeySchalter(): Promise<ApiKeySchalterStand> {
  try {
    const r = await getPool().query<{ aktiv: boolean; grund: string | null; gesetzt_am: Date }>(
      `SELECT aktiv, grund, gesetzt_am FROM agent_profil_schalter WHERE ebene = 'global' AND project IS NULL AND funktion = $1`, [API_KEY_WEBUI_FUNKTION]);
    const z = r.rows[0];
    if (z) return { aktiv: z.aktiv, quelle: 'produkt-schalter', gesetzt_am: z.gesetzt_am.toISOString(), grund: z.grund, letzter_fehler: null };
    return { aktiv: false, quelle: 'standard', gesetzt_am: null, grund: null, letzter_fehler: null };
  } catch {
    return { aktiv: false, quelle: 'standard', gesetzt_am: null, grund: null, letzter_fehler: 'produkt_schalter_nicht_lesbar' };
  }
}

/** Nur der User. Schreibt die globale Zeile funktion 'hauptagent_api_key_webui'. */
export async function setzeApiKeySchalter(akteur: AusweisAkteur | null, e: { aktiv: unknown; grund: unknown }): Promise<ApiKeySchalterStand> {
  if (!akteur || akteur.art !== 'user') fehler('recht_fehlt', { grund: 'Die Key-Eingabe in der Web-UI schaltet nur der User' });
  if (typeof e.aktiv !== 'boolean') fehler('aktiv_fehlt');
  const grund = pflichtText(e.grund, 'grund_fehlt');
  await getPool().query(
    `INSERT INTO agent_profil_schalter (ebene, project, funktion, aktiv, grund, gesetzt_von, setter_identity_id, gesetzt_am)
     VALUES ('global', NULL, $1, $2, $3, 'user', NULL, NOW())
     ON CONFLICT (ebene, (COALESCE(project, '')), funktion) DO UPDATE SET aktiv=EXCLUDED.aktiv, grund=EXCLUDED.grund,
       gesetzt_von=EXCLUDED.gesetzt_von, setter_identity_id=NULL, gesetzt_am=EXCLUDED.gesetzt_am`,
    [API_KEY_WEBUI_FUNKTION, e.aktiv, grund]);
  return leseApiKeySchalter();
}

interface SchluesselZeile { chiffre: string; schluessel_id: string; letzte4: string; grund: string; gesetzt_von: string; gesetzt_am: Date }

/** null = keine Zeile; Lesefehler (z. B. Schema 160 fehlt) wird geworfen und vom Aufrufer als Fehler gezeigt. */
async function leseZeile(): Promise<SchluesselZeile | null> {
  const r = await getPool().query<SchluesselZeile>('SELECT chiffre, schluessel_id, letzte4, grund, gesetzt_von, gesetzt_am FROM api_agent_schluessel WHERE id = 1');
  return r.rows[0] ?? null;
}

export interface ApiKeyAufloesung {
  /** Klartext NUR fuer den Transport; nie in Antworten, Logs oder Audit. */
  key: string | null;
  quelle: 'webui' | 'env' | null;
  fehler: string | null;
}

/** Wirksamer Key: Schalter EIN und lesbare Web-UI-Zeile -> Web-UI, sonst Env, sonst keiner. */
export async function aktuellerApiKey(env: NodeJS.ProcessEnv = process.env): Promise<ApiKeyAufloesung> {
  const envKey = env[API_KEY_ENV]?.trim() || null;
  const schalter = await leseApiKeySchalter();
  let fehlerCode: string | null = schalter.letzter_fehler;
  if (schalter.aktiv) {
    let z: SchluesselZeile | null = null;
    try { z = await leseZeile(); } catch { fehlerCode = 'zeile_nicht_lesbar'; }
    if (z) {
      try {
        return { key: entschluesseleAgentToken(z.chiffre, TRESOR_ID, z.schluessel_id, env), quelle: 'webui', fehler: null };
      } catch (err) {
        fehlerCode = err instanceof TokenTresorFehler ? err.code : 'tresor_fehler';
      }
    }
  }
  return { key: envKey, quelle: envKey ? 'env' : null, fehler: fehlerCode };
}

export interface ApiKeyStand {
  vorhanden: boolean;
  quelle: 'webui' | 'env' | null;
  gesetzt_am: string | null;
  letzte4: string | null;
  webui: { gespeichert: boolean; gesetzt_am: string | null; letzte4: string | null; lesbar: boolean };
  env: { vorhanden: boolean; letzte4: string | null };
  schalter: ApiKeySchalterStand;
  tresor: { vorhanden: boolean; schluessel_id: string | null; quelle: string };
  fehler: string | null;
  /** P22-T179 Nachtrag: Workspace-ID (Env SYNAPSE_ANTHROPIC_WORKSPACE_ID) gesetzt - nur ja/nein, nie der Wert. */
  workspace_id_gesetzt: boolean;
  /** Debugzeile (regel-neue-funktionen-mit-schalter-und-debug): woher der Key kommt und warum. Nie ein Key-Wert. */
  debug: string;
}

/** Stand ohne Geheimnis. Fehlt Schema 160, gilt 'keine Zeile' mit fehler zeile_nicht_lesbar. */
export async function leseApiKeyStand(env: NodeJS.ProcessEnv = process.env): Promise<ApiKeyStand> {
  const envKey = env[API_KEY_ENV]?.trim() || null;
  const tresor = tokenSchluesselStand(env);
  let z: SchluesselZeile | null = null;
  let zeilenFehler: string | null = null;
  try { z = await leseZeile(); } catch { zeilenFehler = 'zeile_nicht_lesbar'; }
  const a = await aktuellerApiKey(env);
  const fehlerCode = a.fehler ?? zeilenFehler;
  const webuiLesbar = a.quelle === 'webui';
  const schalter = await leseApiKeySchalter();
  const gesetzt_am = a.quelle === 'webui' && z ? z.gesetzt_am.toISOString() : null;
  const wirksam4 = a.quelle === 'webui' ? z?.letzte4 ?? null : a.quelle === 'env' && envKey ? letzte4(envKey) : null;
  return {
    vorhanden: !!a.key, quelle: a.quelle, gesetzt_am, letzte4: wirksam4,
    webui: { gespeichert: !!z, gesetzt_am: z ? z.gesetzt_am.toISOString() : null, letzte4: z?.letzte4 ?? null, lesbar: webuiLesbar },
    env: { vorhanden: !!envKey, letzte4: envKey ? letzte4(envKey) : null },
    schalter,
    tresor: { vorhanden: tresor.vorhanden, schluessel_id: tresor.schluessel_id, quelle: tresor.quelle },
    fehler: fehlerCode,
    workspace_id_gesetzt: !!anthropicWorkspaceId(env),
    debug: 'quelle=' + (a.quelle ?? 'keine') + ' schalter=' + (schalter.aktiv ? 'EIN' : 'AUS') + '(' + schalter.quelle + ')'
      + ' webui_zeile=' + (z ? 'ja' : 'nein') + ' tresor=' + (tresor.vorhanden ? 'ja(' + tresor.schluessel_id + ')' : 'nein')
      + ' env=' + (envKey ? 'ja' : 'nein') + (fehlerCode ? ' fehler=' + fehlerCode : '') + ' workspace=' + (anthropicWorkspaceId(env) ? 'ja' : 'nein'),
  };
}

/** Nur der User, nur bei Schalter EIN. Hinterlegt oder ersetzt den Key (verschluesselt); Antwort ist der Stand ohne Wert. */
export async function setzeApiKey(akteur: AusweisAkteur | null, e: { key: unknown; grund: unknown }, env: NodeJS.ProcessEnv = process.env): Promise<ApiKeyStand> {
  if (!akteur || akteur.art !== 'user') fehler('recht_fehlt', { grund: 'Den API-Key hinterlegt nur der User' });
  if (!(await leseApiKeySchalter()).aktiv) fehler('funktion_aus', { funktion: API_KEY_WEBUI_FUNKTION });
  const grund = pflichtText(e.grund, 'grund_fehlt');
  const key = typeof e.key === 'string' ? e.key.trim() : '';
  if (!API_KEY_FORM.test(key)) fehler('api_key_ungueltig', { erwartet: "'sk-ant-' und danach nur Buchstaben, Ziffern, '-' und '_'" });
  let v: { chiffre: string; schluessel_id: string };
  try {
    v = verschluesseleAgentToken(key, TRESOR_ID, env);
  } catch (err) {
    return fehler(err instanceof TokenTresorFehler ? err.code : 'tresor_fehler', { tresor: 'SYNAPSE_AGENT_TOKEN_SCHLUESSEL' });
  }
  await getPool().query(
    `INSERT INTO api_agent_schluessel (id, chiffre, schluessel_id, letzte4, grund, gesetzt_von, gesetzt_am)
     VALUES (1, $1, $2, $3, $4, 'user', NOW())
     ON CONFLICT (id) DO UPDATE SET chiffre=EXCLUDED.chiffre, schluessel_id=EXCLUDED.schluessel_id, letzte4=EXCLUDED.letzte4,
       grund=EXCLUDED.grund, gesetzt_von=EXCLUDED.gesetzt_von, gesetzt_am=EXCLUDED.gesetzt_am`,
    [v.chiffre, v.schluessel_id, letzte4(key), grund]);
  return leseApiKeyStand(env);
}

/** Nur der User (auch bei Schalter AUS, zum Aufraeumen). Danach gilt wieder Env. */
export async function entferneApiKey(akteur: AusweisAkteur | null, e: { grund: unknown }, env: NodeJS.ProcessEnv = process.env): Promise<ApiKeyStand> {
  if (!akteur || akteur.art !== 'user') fehler('recht_fehlt', { grund: 'Den API-Key entfernt nur der User' });
  pflichtText(e.grund, 'grund_fehlt');
  await getPool().query('DELETE FROM api_agent_schluessel WHERE id = 1');
  return leseApiKeyStand(env);
}
