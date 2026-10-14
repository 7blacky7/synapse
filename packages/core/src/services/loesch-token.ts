/**
 * P9-T31: Rechnergebundener Loesch-Code (eigenes TOTP-Geheimnis je Rechner).
 *
 * REGELN (User 14.10.2026, Task P9-T31 + thought a78f5248):
 * - EIGENES Geheimnis, NIE der Login-TOTP (auth_totp). Der Loesch-Code laesst sich gegen nichts tauschen.
 * - Je Rechner (hostname) genau ein wirksames Geheimnis. Ein Code von Rechner A gilt nie fuer Rechner B,
 *   weil jede Pruefung ausschliesslich das Geheimnis des Rechners aus dem Loesch-Auftrag liest.
 * - Einrichtung/Zuruecksetzen nur ueber die Tray-Route (Daemon-Zugang genau dieses Rechners + Login-TOTP des
 *   Users), nie ueber ein Agenten-Tool. Ein neues Geheimnis wird erst mit dem ersten richtigen Code wirksam;
 *   bis dahin gilt das alte weiter.
 * - Gueltigkeit ca. 3 Minuten: 30-s-Zeitschritte, akzeptiert werden bis zu 6 Schritte zurueck und 1 voraus
 *   (Uhrendrift). Jeder Code nur EINMAL: der benutzte Zeitschritt wird gespeichert, gleich alte oder aeltere
 *   Codes sind danach ungueltig (RFC 6238, Abschnitt 5.2).
 * - Geheimnis und Code erscheinen nie in Antworten, Fehlermeldungen oder Logs. Aufbewahrung serverseitig in
 *   loesch_geheimnisse (wie auth_totp: Klartext-Base32 in der System-DB, nur ueber die API erreichbar).
 *
 * Kompatibel mit Authenticator-Apps: SHA1, 6 Stellen, 30 s (otpauth-URI mit Aussteller "Synapse-Loeschen").
 * Kein otplib in core noetig — HOTP/TOTP ist hier mit node:crypto umgesetzt.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db/client.js';

export const LOESCH_TOTP_PERIODE_S = 30;
export const LOESCH_TOTP_STELLEN = 6;
/** Schritte zurueck (6 x 30 s = 3 Minuten) und voraus (Uhrendrift). */
export const LOESCH_TOTP_ZURUECK = 6;
export const LOESCH_TOTP_VOR = 1;
export const LOESCH_TOTP_AUSSTELLER = 'Synapse-Loeschen';
/** Virtueller API-Host der Registry (nie ein Rechner mit Platte). */
const VIRTUELLER_HOST = 'rest-api';

export class LoeschTokenFehler extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus = 409) {
    super(message);
    this.name = 'LoeschTokenFehler';
  }
}
const fail = (code: string, message: string, status = 409): never => {
  throw new LoeschTokenFehler(code, message, status);
};

// ── Base32 (RFC 4648, ohne Padding) ─────────────────────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Kodieren(buf: Buffer): string {
  let bits = 0;
  let wert = 0;
  let aus = '';
  for (const b of buf) {
    wert = (wert << 8) | b;
    bits += 8;
    while (bits >= 5) {
      aus += B32[(wert >>> (bits - 5)) & 31];
      bits -= 5;
      wert &= (1 << bits) - 1;
    }
  }
  if (bits > 0) aus += B32[(wert << (5 - bits)) & 31];
  return aus;
}

export function base32Dekodieren(text: string): Buffer {
  const rein = text.toUpperCase().replace(/\s+/g, '').replace(/=+$/, '');
  let bits = 0;
  let wert = 0;
  const aus: number[] = [];
  for (const zeichen of rein) {
    const i = B32.indexOf(zeichen);
    if (i < 0) fail('geheimnis_ungueltig', 'Gespeichertes Loesch-Geheimnis ist ungueltig.', 500);
    wert = (wert << 5) | i;
    bits += 5;
    if (bits >= 8) {
      aus.push((wert >>> (bits - 8)) & 255);
      bits -= 8;
      wert &= (1 << bits) - 1;
    }
  }
  return Buffer.from(aus);
}

/** HOTP (RFC 4226) fuer einen TOTP-Zeitschritt. */
export function totpCode(geheimnis: Buffer, zeitschritt: number): string {
  const zaehler = Buffer.alloc(8);
  zaehler.writeBigUInt64BE(BigInt(zeitschritt));
  const h = createHmac('sha1', geheimnis).update(zaehler).digest();
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** LOESCH_TOTP_STELLEN).padStart(LOESCH_TOTP_STELLEN, '0');
}

export function zeitschrittVon(jetztMs: number): number {
  return Math.floor(jetztMs / 1000 / LOESCH_TOTP_PERIODE_S);
}

/** Normiert die Eingabe (Leerzeichen raus, Zahl mit fuehrenden Nullen). null = Form ungueltig. */
export function normiereLoeschCode(code: unknown): string | null {
  let text: string;
  if (typeof code === 'number' && Number.isInteger(code) && code >= 0 && code < 10 ** LOESCH_TOTP_STELLEN) {
    text = String(code).padStart(LOESCH_TOTP_STELLEN, '0');
  } else if (typeof code === 'string') {
    text = code.replace(/[\s-]+/g, '');
  } else {
    return null;
  }
  return new RegExp(`^\\d{${LOESCH_TOTP_STELLEN}}$`).test(text) ? text : null;
}

/**
 * Sucht den Zeitschritt, zu dem der Code passt (neuester zuerst). Vergleicht ALLE Schritte im Fenster in
 * konstanter Zeit, damit die Laufzeit nichts ueber den Treffer verraet. null = kein Treffer.
 */
export function findeZeitschritt(geheimnisBase32: string, code: string, jetztMs = Date.now()): number | null {
  const normiert = normiereLoeschCode(code);
  if (!normiert) return null;
  const geheimnis = base32Dekodieren(geheimnisBase32);
  const jetzt = zeitschrittVon(jetztMs);
  const eingabe = Buffer.from(normiert);
  let treffer: number | null = null;
  for (let s = jetzt + LOESCH_TOTP_VOR; s >= jetzt - LOESCH_TOTP_ZURUECK; s--) {
    const passt = timingSafeEqual(Buffer.from(totpCode(geheimnis, s)), eingabe);
    if (passt && treffer === null) treffer = s;
  }
  return treffer;
}

/** Rechnername: Pflicht, ohne Leer-/Pfadzeichen, nie der virtuelle API-Host. */
export function pruefeLoeschHost(h: unknown): asserts h is string {
  if (typeof h !== 'string' || !h.trim() || h.length > 200 || /[\s/\\\x00]/.test(h)) {
    fail('host_ungueltig', 'hostname (Rechner) ungueltig oder fehlt.', 400);
  }
  if (h === VIRTUELLER_HOST) fail('virtueller_host', `"${VIRTUELLER_HOST}" ist kein Rechner und hat keinen Loesch-Code.`, 400);
}

export interface LoeschTokenStatus {
  hostname: string;
  eingerichtet: boolean;
  bestaetigt_at: string | null;
  einrichtung_offen: boolean;
}

/** Zustand fuer Anzeige (Tray/Vorschau). Liefert NIE das Geheimnis. */
export async function loeschTokenStatus(hostname: string, db: Pool | PoolClient = getPool()): Promise<LoeschTokenStatus> {
  pruefeLoeschHost(hostname);
  const r = await db.query<{ hat: boolean; offen: boolean; bestaetigt_at: Date | null }>(
    `SELECT geheimnis IS NOT NULL AS hat, neues_geheimnis IS NOT NULL AS offen, bestaetigt_at
       FROM loesch_geheimnisse WHERE hostname = $1`, [hostname]);
  const z = r.rows[0];
  return {
    hostname,
    eingerichtet: z?.hat === true,
    bestaetigt_at: z?.bestaetigt_at ? new Date(z.bestaetigt_at).toISOString() : null,
    einrichtung_offen: z?.offen === true,
  };
}

function otpauthUri(hostname: string, geheimnis: string): string {
  const label = encodeURIComponent(`${LOESCH_TOTP_AUSSTELLER}:${hostname}`);
  return `otpauth://totp/${label}?secret=${geheimnis}&issuer=${encodeURIComponent(LOESCH_TOTP_AUSSTELLER)}` +
    `&algorithm=SHA1&digits=${LOESCH_TOTP_STELLEN}&period=${LOESCH_TOTP_PERIODE_S}`;
}

/**
 * Tray-Einrichtung (Aufrufer prueft Daemon-Zugang DIESES Rechners und den Login-TOTP des Users).
 * Legt ein NEUES Geheimnis an, das erst mit loeschTokenBestaetigen wirksam wird. Die otpauth-URI geht nur an
 * den Tray (QR-Code), nie an ein Agenten-Tool.
 */
export async function loeschTokenEinrichten(
  hostname: string,
  o: { von?: string; db?: Pool } = {},
): Promise<{ hostname: string; otpauth_uri: string; ersetzt_bestehendes: boolean }> {
  pruefeLoeschHost(hostname);
  const db = o.db ?? getPool();
  const geheimnis = base32Kodieren(randomBytes(20));
  // Sicherheitsnetz: nie identisch mit dem Login-TOTP (praktisch ausgeschlossen, aber billig geprueft).
  const login = await db.query<{ secret: string }>('SELECT secret FROM auth_totp WHERE id = 1').catch(() => ({ rows: [] as Array<{ secret: string }> }));
  if (login.rows[0]?.secret && login.rows[0].secret.toUpperCase() === geheimnis) {
    fail('geheimnis_kollision', 'Neues Loesch-Geheimnis kollidiert mit dem Login-TOTP — bitte erneut einrichten.', 500);
  }
  const r = await db.query<{ ersetzt: boolean }>(
    `INSERT INTO loesch_geheimnisse (hostname, neues_geheimnis, eingerichtet_von)
     VALUES ($1, $2, $3)
     ON CONFLICT (hostname) DO UPDATE
       SET neues_geheimnis = EXCLUDED.neues_geheimnis, eingerichtet_von = EXCLUDED.eingerichtet_von, updated_at = NOW()
     RETURNING (geheimnis IS NOT NULL) AS ersetzt`,
    [hostname, geheimnis, o.von ?? null]);
  return { hostname, otpauth_uri: otpauthUri(hostname, geheimnis), ersetzt_bestehendes: r.rows[0]?.ersetzt === true };
}

/** Tray: erster Code aus der App macht das neue Geheimnis wirksam (altes verfaellt). */
export async function loeschTokenBestaetigen(
  hostname: string,
  code: unknown,
  o: { db?: Pool; jetztMs?: number } = {},
): Promise<LoeschTokenStatus> {
  pruefeLoeschHost(hostname);
  const normiert = normiereLoeschCode(code);
  if (!normiert) fail('code_ungueltig', 'Code muss aus 6 Ziffern bestehen.', 400);
  const db = o.db ?? getPool();
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const z = (await c.query<{ neues_geheimnis: string | null }>(
      'SELECT neues_geheimnis FROM loesch_geheimnisse WHERE hostname = $1 FOR UPDATE', [hostname])).rows[0];
    if (!z?.neues_geheimnis) fail('keine_einrichtung_offen', 'Fuer diesen Rechner wartet keine Einrichtung auf Bestaetigung.', 409);
    const schritt = findeZeitschritt(z!.neues_geheimnis!, normiert!, o.jetztMs ?? Date.now());
    if (schritt === null) fail('code_ungueltig', 'Code passt nicht zum neu eingerichteten Loesch-Geheimnis.', 403);
    await c.query(
      `UPDATE loesch_geheimnisse
          SET geheimnis = neues_geheimnis, neues_geheimnis = NULL, bestaetigt_at = NOW(),
              letzter_zeitschritt = $2, updated_at = NOW()
        WHERE hostname = $1`, [hostname, schritt]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  return loeschTokenStatus(hostname, db);
}

/**
 * Prueft einen Loesch-Code gegen das Geheimnis GENAU dieses Rechners und verbraucht ihn (Replay-Schutz).
 * MUSS in einer offenen Transaktion des Aufrufers laufen (Zeilensperre FOR UPDATE). false = falsch,
 * abgelaufen oder schon benutzt — ohne Unterscheidung nach aussen.
 */
export async function pruefeLoeschCode(
  client: PoolClient,
  hostname: string,
  code: unknown,
  jetztMs = Date.now(),
): Promise<boolean> {
  pruefeLoeschHost(hostname);
  const z = (await client.query<{ geheimnis: string | null; letzter_zeitschritt: string }>(
    'SELECT geheimnis, letzter_zeitschritt FROM loesch_geheimnisse WHERE hostname = $1 FOR UPDATE', [hostname])).rows[0];
  if (!z?.geheimnis) {
    fail('kein_loesch_token', `Fuer Rechner "${hostname}" ist kein Loesch-Code eingerichtet (Tray: "Loesch-Code einrichten").`, 409);
  }
  const normiert = normiereLoeschCode(code);
  if (!normiert) return false;
  const schritt = findeZeitschritt(z!.geheimnis!, normiert, jetztMs);
  if (schritt === null || schritt <= Number(z!.letzter_zeitschritt)) return false;
  await client.query(
    'UPDATE loesch_geheimnisse SET letzter_zeitschritt = $2, updated_at = NOW() WHERE hostname = $1 AND letzter_zeitschritt < $2',
    [hostname, schritt]);
  return true;
}

// ── Login-TOTP beim Einrichten: Versuchsbegrenzung je Rechner (B3, Testbericht 3abbebaa) ────────────────
/** verifyTotp (rest-api) begrenzt selbst nicht. Wer den Daemon-Zugang eines Rechners hat, darf nur so oft raten. */
export const LOESCH_LOGIN_SPERRE_FEHLVERSUCHE = 5;
export const LOESCH_LOGIN_SPERRE_MINUTEN = 15;

/**
 * Prueft den Login-Code fuer die Einrichtung des Loesch-Codes mit Sperre je Rechner:
 * - Ab LOESCH_LOGIN_SPERRE_FEHLVERSUCHE Fehlversuchen in LOESCH_LOGIN_SPERRE_MINUTEN Minuten -> 429 login_gesperrt,
 *   OHNE den Code zu pruefen (auch ein richtiger Code hilft dann nicht). Die Sperre laeuft mit dem Zeitfenster ab.
 * - Jeder Fehlversuch (auch falsche Form) wird gezaehlt. Versuche desselben Rechners laufen nacheinander
 *   (Advisory-Lock), damit parallele Anfragen die Grenze nicht ueberspringen.
 * pruefe() liefert true = Login-Code richtig. Rueckgabe wie pruefe(); wirft nur bei Sperre.
 */
export async function pruefeLoeschLoginMitSperre(
  hostname: string,
  pruefe: () => Promise<boolean>,
  o: { db?: Pool } = {},
): Promise<boolean> {
  pruefeLoeschHost(hostname);
  const db = o.db ?? getPool();
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['loesch-login:' + hostname]);
    const n = Number((await c.query<{ n: string }>(
      `SELECT count(*)::bigint AS n FROM loesch_login_fehlversuche
        WHERE hostname = $1 AND created_at > NOW() - ($2 || ' minutes')::interval`,
      [hostname, String(LOESCH_LOGIN_SPERRE_MINUTEN)])).rows[0]?.n ?? 0);
    if (n >= LOESCH_LOGIN_SPERRE_FEHLVERSUCHE) {
      fail('login_gesperrt', `Zu viele falsche Login-Codes fuer Rechner "${hostname}" — Einrichtung ${LOESCH_LOGIN_SPERRE_MINUTEN} Minuten gesperrt.`, 429);
    }
    let ok = false;
    try { ok = (await pruefe()) === true; } catch { ok = false; }
    if (!ok) {
      await c.query('INSERT INTO loesch_login_fehlversuche (hostname) VALUES ($1)', [hostname]);
      // Alte Zeilen DIESES Rechners aufraeumen (laengst ausserhalb jedes Fensters).
      await c.query("DELETE FROM loesch_login_fehlversuche WHERE hostname = $1 AND created_at < NOW() - interval '1 day'", [hostname]);
    }
    await c.query('COMMIT');
    return ok;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
