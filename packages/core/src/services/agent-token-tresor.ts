/**
 * P22-T13 Phase V (Vertrag fuer Paket D): verschluesselte, berechtigt abrufbare Ablage der
 * Agenten-Ausweise (User 02845fc2: Koordinator/User koennen Tokens jederzeit auslesen).
 *
 * SPEICHERORT (Schema 113): agent_identitaet_tokens.token_verschluesselt + token_schluessel_id;
 *   fuer Schattenprofile agent_schattenprofile.vorgesehener_token_verschluesselt/_schluessel_id.
 *   Der Hash (token_hash) bleibt die einzige Grundlage der Identifikationspruefung.
 * SCHLUESSELHERKUNFT: ausschliesslich die geschuetzte API-Betriebskonfiguration, Env
 *   SYNAPSE_AGENT_TOKEN_SCHLUESSEL (32 Byte, als 64 Hex-Zeichen oder Base64). Nie im Profil, Repo,
 *   Client, Daemon, Log, Audit oder in PG. token_schluessel_id = erste 16 Hex von
 *   SHA-256('synapse-agent-token-schluessel:' + Schluessel): erkennt Rotation, verraet nichts.
 *   Fehlt/ungueltig -> Fehler token_schluessel_fehlt; es gibt KEINEN Klartext-Fallback.
 * VERFAHREN: AES-256-GCM, 12 Byte Zufalls-IV, AAD 'synapse-agent-token:v1:' + token_id (bindet den
 *   Chiffretext an genau seine Zeile). Format 'v1:<iv b64>:<tag b64>:<chiffre b64>'.
 * NOCH NICHT VERDRAHTET: stelleAgentTokenAus speichert weiter nur Hash (Paket D verdrahtet Ablage,
 *   auditierten Abruf und Web-UI-Anzeige). Fehlertexte enthalten nie Schluessel- oder Tokenwerte.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export class TokenTresorFehler extends Error {
  constructor(public readonly code: string) { super(code); }
}

function schluessel(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const roh = env.SYNAPSE_AGENT_TOKEN_SCHLUESSEL?.trim();
  if (!roh) return null;
  const b = /^[a-f0-9]{64}$/i.test(roh) ? Buffer.from(roh, 'hex') : Buffer.from(roh, 'base64');
  return b.length === 32 ? b : null;
}

function schluesselId(k: Buffer): string {
  return createHash('sha256').update('synapse-agent-token-schluessel:').update(k).digest('hex').slice(0, 16);
}

export interface TokenSchluesselStand {
  vorhanden: boolean;
  schluessel_id: string | null;
  quelle: 'SYNAPSE_AGENT_TOKEN_SCHLUESSEL';
}

export function tokenSchluesselStand(env: NodeJS.ProcessEnv = process.env): TokenSchluesselStand {
  const k = schluessel(env);
  return { vorhanden: !!k, schluessel_id: k ? schluesselId(k) : null, quelle: 'SYNAPSE_AGENT_TOKEN_SCHLUESSEL' };
}

function aad(tokenId: string): Buffer {
  return Buffer.from('synapse-agent-token:v1:' + tokenId, 'utf8');
}

export function verschluesseleAgentToken(
  token: string, tokenId: string, env: NodeJS.ProcessEnv = process.env,
): { chiffre: string; schluessel_id: string } {
  const k = schluessel(env);
  if (!k) throw new TokenTresorFehler('token_schluessel_fehlt');
  if (typeof token !== 'string' || !token || typeof tokenId !== 'string' || !tokenId) throw new TokenTresorFehler('token_eingabe_ungueltig');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(aad(tokenId));
  const ct = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return { chiffre: ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':'),
    schluessel_id: schluesselId(k) };
}

export function entschluesseleAgentToken(
  chiffre: string, tokenId: string, erwarteteSchluesselId?: string | null, env: NodeJS.ProcessEnv = process.env,
): string {
  const k = schluessel(env);
  if (!k) throw new TokenTresorFehler('token_schluessel_fehlt');
  if (erwarteteSchluesselId && erwarteteSchluesselId !== schluesselId(k)) throw new TokenTresorFehler('token_schluessel_gewechselt');
  const teile = typeof chiffre === 'string' ? chiffre.split(':') : [];
  if (teile.length !== 4 || teile[0] !== 'v1') throw new TokenTresorFehler('token_chiffre_ungueltig');
  try {
    const d = createDecipheriv('aes-256-gcm', k, Buffer.from(teile[1], 'base64'));
    d.setAAD(aad(tokenId));
    d.setAuthTag(Buffer.from(teile[2], 'base64'));
    return Buffer.concat([d.update(Buffer.from(teile[3], 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new TokenTresorFehler('token_chiffre_ungueltig');
  }
}
