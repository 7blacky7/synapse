/**
 * MODUL: Auth-Service (PLAN-002, AUTH-2)
 * ZWECK: Reiner, typisierter Baustein fuer 2FA/OAuth der Synapse-REST-API.
 *        Stellt TOTP-, PKCE- und Token-Primitiven bereit. KEINE Fastify-Routen
 *        und KEIN Auth-Hook hier (das sind AUTH-3/AUTH-4/AUTH-5).
 *
 * STORAGE: PostgreSQL via getPool() aus @synapse/core. Tabellen aus AUTH-1
 *          (schema.ts AUTH_SCHEMA_SQL): auth_totp, auth_oauth_clients, auth_tokens.
 *          Klartext-Token werden NIE gespeichert — nur deren SHA-256-Hash.
 *
 * TTLs (final, PLAN-002):
 *   - Access-Token:  24h
 *   - Refresh-Token: 120 Tage ABSOLUT ab TOTP-Login (NICHT sliding).
 *   - Auth-Code:     10 min.
 *
 * NEBENEFFEKTE: PostgreSQL read/write auf den drei auth_*-Tabellen.
 */

import { randomBytes, createHash } from 'node:crypto';
import { OTP } from 'otplib';
import * as QRCode from 'qrcode';
import { getPool } from '@synapse/core';

/**
 * otplib v13 ist klassenbasiert (kein `authenticator`-Singleton mehr wie v12).
 * Eine TOTP-Instanz (RFC 6238: SHA-1, 6 Stellen, 30s-Step) reicht prozessweit.
 */
const totp = new OTP({ strategy: 'totp' });

/**
 * Toleranz fuer TOTP-Verifikation in SEKUNDEN (otplib v13: epochTolerance).
 * 30s == genau ein 30s-Zeitschritt vor/nach jetzt == das fruehere window:+/-1.
 */
const TOTP_TOLERANCE_SEC = 30;

// ---------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Access-Token Lebensdauer: 24h. */
export const ACCESS_TTL_MS = 24 * HOUR;
/** Refresh-Token Lebensdauer: 120 Tage absolut. */
export const REFRESH_TTL_MS = 120 * DAY;
/** Auth-Code Lebensdauer: 10 Minuten. */
export const AUTHCODE_TTL_MS = 10 * MINUTE;
/** Web-UI Session-Token Lebensdauer: 24h. */
export const SESSION_TTL_MS = 24 * HOUR;

/** Default-Aussteller/Label fuer die otpauth-URI (Authenticator-App). */
const DEFAULT_ISSUER = 'Synapse';

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export type TokenKind = 'access' | 'refresh' | 'authcode' | 'session' | 'service';

/** Eine Zeile aus auth_tokens (Klartext-Token ist NIE enthalten). */
export interface AuthTokenRow {
  token_hash: string;
  kind: TokenKind;
  client_id: string | null;
  scope: string | null;
  label: string | null;
  redirect_uri: string | null;
  code_challenge: string | null;
  parent_token: string | null;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
}

/** Rueckgabe beim Ausstellen eines Tokens: Klartext (einmalig!) + Metadaten. */
export interface IssuedToken {
  /** Klartext-Token — nur HIER verfuegbar, wird nirgends persistiert. */
  token: string;
  kind: TokenKind;
  clientId: string | null;
  scope: string | null;
  expiresAt: Date | null;
}

/** Ergebnis einer Refresh-Rotation: neues Access- + neues Refresh-Token. */
export interface RotatedTokens {
  access: IssuedToken;
  refresh: IssuedToken;
}

// ---------------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------------

/** SHA-256-Hash (hex) eines Klartext-Tokens — so wird in PG gespeichert. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Kryptographisch sicheres Klartext-Token: 32 Bytes als Hex (64 Zeichen). */
function generateToken(): string {
  return randomBytes(32).toString('hex');
}

// ===========================================================================
// TOTP (Time-based One-Time Password)
// ===========================================================================

/**
 * Liefert das (Single-Row) TOTP-Secret. Existiert keins, wird eines erzeugt
 * und persistiert. Bootstrap-Quelle optional ENV SYNAPSE_TOTP_SECRET.
 * Das zurueckgegebene Secret ist base32 (otplib-kompatibel).
 */
export async function getOrCreateTotpSecret(): Promise<string> {
  const pool = getPool();
  const existing = await pool.query<{ secret: string }>(
    'SELECT secret FROM auth_totp WHERE id = 1',
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].secret;
  }

  const secret = (process.env.SYNAPSE_TOTP_SECRET || '').trim() || totp.generateSecret();
  // ON CONFLICT schuetzt gegen Races (zwei Prozesse bootstrappen gleichzeitig).
  const inserted = await pool.query<{ secret: string }>(
    `INSERT INTO auth_totp (id, secret) VALUES (1, $1)
     ON CONFLICT (id) DO NOTHING
     RETURNING secret`,
    [secret],
  );
  if (inserted.rows.length > 0) {
    return inserted.rows[0].secret;
  }
  // Race verloren: ein anderer Prozess hat zuerst eingefuegt -> dessen Secret lesen.
  const reread = await pool.query<{ secret: string }>(
    'SELECT secret FROM auth_totp WHERE id = 1',
  );
  return reread.rows[0].secret;
}

/**
 * Baut die otpauth://-URI fuer den QR-Code (Authenticator-App-Import).
 * @param accountName Account-Label (z.B. Domain/Username), Default = issuer.
 * @param issuer Aussteller-Name, Default 'Synapse'.
 */
export async function buildOtpauthUri(
  accountName = DEFAULT_ISSUER,
  issuer = DEFAULT_ISSUER,
): Promise<string> {
  const secret = await getOrCreateTotpSecret();
  return totp.generateURI({ issuer, label: accountName, secret });
}

/** Erzeugt aus einer otpauth-URI einen QR-Code als data:image/png;base64-URL. */
export async function generateQrDataUrl(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 256 });
}

/**
 * Verifiziert einen 6-stelligen TOTP-Code gegen das gespeicherte Secret.
 * Toleriert eine 30s-Zeitscheibe vor/nach jetzt (= window +/-1 / Uhren-Drift).
 */
export async function verifyTotp(code: string): Promise<boolean> {
  const secret = await getOrCreateTotpSecret();
  const token = (code || '').trim();
  if (!token) return false;
  // epochTolerance: 30s = ein 30s-Step Toleranz in beide Richtungen (frueher window:+/-1).
  return totp.verifySync({ secret, token, epochTolerance: TOTP_TOLERANCE_SEC }).valid;
}

/**
 * Bestaetigt die TOTP-Einrichtung: prueft den Code und setzt — bei Erfolg —
 * confirmed_at. Idempotent. Liefert true bei gueltigem Code.
 */
export async function confirmTotp(code: string): Promise<boolean> {
  const ok = await verifyTotp(code);
  if (!ok) return false;
  const pool = getPool();
  await pool.query(
    'UPDATE auth_totp SET confirmed_at = NOW() WHERE id = 1 AND confirmed_at IS NULL',
  );
  return true;
}

/** True, wenn TOTP eingerichtet UND bestaetigt wurde. */
export async function isTotpConfirmed(): Promise<boolean> {
  const pool = getPool();
  const res = await pool.query<{ confirmed_at: Date | null }>(
    'SELECT confirmed_at FROM auth_totp WHERE id = 1',
  );
  return res.rows.length > 0 && res.rows[0].confirmed_at != null;
}

// ===========================================================================
// PKCE (Proof Key for Code Exchange, RFC 7636 — S256)
// ===========================================================================

/** base64url-Encoding ohne Padding (RFC 7636). */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Verifiziert einen PKCE-S256-Verifier gegen die gespeicherte Challenge.
 * Pflicht: claude.ai + ChatGPT senden immer code_challenge_method=S256.
 * challenge == base64url(SHA-256(verifier)).
 */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || !codeChallenge) return false;
  const computed = base64url(createHash('sha256').update(codeVerifier).digest());
  // Konstantzeit-Vergleich vermeiden wir hier bewusst nicht: base64url-Strings
  // gleicher Laenge; ein simpler === reicht fuer den S256-Vergleich (kein Secret-Leak,
  // da Challenge ohnehin oeffentlich uebertragen wird).
  return computed === codeChallenge;
}

// ===========================================================================
// Tokens (access | refresh | authcode | session | service)
// ===========================================================================

/**
 * Interner Insert-Helfer. Gibt das Klartext-Token zurueck (nur hier verfuegbar).
 */
async function insertToken(params: {
  kind: TokenKind;
  clientId?: string | null;
  scope?: string | null;
  label?: string | null;
  redirectUri?: string | null;
  codeChallenge?: string | null;
  parentToken?: string | null;
  /** Absolutes Ablaufdatum; null = kein Ablauf (z.B. service-Token). */
  expiresAt: Date | null;
}): Promise<IssuedToken> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const pool = getPool();
  await pool.query(
    `INSERT INTO auth_tokens
       (token_hash, kind, client_id, scope, label, redirect_uri, code_challenge, parent_token, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      tokenHash,
      params.kind,
      params.clientId ?? null,
      params.scope ?? null,
      params.label ?? null,
      params.redirectUri ?? null,
      params.codeChallenge ?? null,
      params.parentToken ?? null,
      params.expiresAt,
    ],
  );
  return {
    token,
    kind: params.kind,
    clientId: params.clientId ?? null,
    scope: params.scope ?? null,
    expiresAt: params.expiresAt,
  };
}

/** Stellt ein Access-Token aus (Default-TTL 24h). */
export async function issueAccessToken(
  clientId: string,
  scope: string | null = null,
  ttlMs: number = ACCESS_TTL_MS,
  parentToken: string | null = null,
): Promise<IssuedToken> {
  return insertToken({
    kind: 'access',
    clientId,
    scope,
    parentToken,
    expiresAt: new Date(Date.now() + ttlMs),
  });
}

/**
 * Stellt ein Refresh-Token aus. TTL ist ABSOLUT (120 Tage ab Login,
 * KEIN sliding). Die Rotation (rotateRefresh) behaelt dieses absolute Datum bei.
 */
export async function issueRefreshToken(
  clientId: string,
  scope: string | null = null,
  ttlMs: number = REFRESH_TTL_MS,
): Promise<IssuedToken> {
  return insertToken({
    kind: 'refresh',
    clientId,
    scope,
    expiresAt: new Date(Date.now() + ttlMs),
  });
}

/**
 * Stellt einen OAuth Authorization-Code aus (TTL 10min). Speichert PKCE-
 * code_challenge + redirect_uri fuer die spaetere /token-Validierung.
 */
export async function issueAuthCode(
  clientId: string,
  redirectUri: string,
  scope: string | null,
  codeChallenge: string | null,
  ttlMs: number = AUTHCODE_TTL_MS,
): Promise<IssuedToken> {
  return insertToken({
    kind: 'authcode',
    clientId,
    scope,
    redirectUri,
    codeChallenge,
    expiresAt: new Date(Date.now() + ttlMs),
  });
}

/**
 * Stellt ein Web-UI Session-Token aus (TTL 24h, nach erfolgreichem
 * verify_2fa_session). Kein client_id (User-Session, nicht OAuth-Client).
 */
export async function issueSessionToken(
  scope: string | null = null,
  ttlMs: number = SESSION_TTL_MS,
): Promise<IssuedToken> {
  return insertToken({
    kind: 'session',
    scope,
    expiresAt: new Date(Date.now() + ttlMs),
  });
}

/**
 * Validiert ein Klartext-Token: liefert die Zeile, wenn vorhanden UND nicht
 * abgelaufen, sonst null. Aktualisiert bei Erfolg last_used_at (touch).
 * Abgelaufene Tokens werden als ungueltig behandelt (null).
 */
export async function validateToken(token: string): Promise<AuthTokenRow | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const pool = getPool();
  // Touch last_used_at nur wenn nicht abgelaufen; RETURNING liefert die Zeile.
  const res = await pool.query<AuthTokenRow>(
    `UPDATE auth_tokens
        SET last_used_at = NOW()
      WHERE token_hash = $1
        AND (expires_at IS NULL OR expires_at > NOW())
      RETURNING token_hash, kind, client_id, scope, label, redirect_uri,
                code_challenge, parent_token, created_at, expires_at, last_used_at`,
    [tokenHash],
  );
  return res.rows[0] ?? null;
}

/**
 * Liest eine Token-Zeile per Klartext OHNE last_used_at zu beruehren und OHNE
 * Ablauf-Filter. Nuetzlich fuer Flows die selbst ueber Ablauf/kind entscheiden
 * (z.B. authcode-Einloesung). Liefert null wenn unbekannt.
 */
export async function getTokenRow(token: string): Promise<AuthTokenRow | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const pool = getPool();
  const res = await pool.query<AuthTokenRow>(
    `SELECT token_hash, kind, client_id, scope, label, redirect_uri,
            code_challenge, parent_token, created_at, expires_at, last_used_at
       FROM auth_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  return res.rows[0] ?? null;
}

/**
 * OAuth-2.1-konforme Refresh-Rotation:
 *   - prueft das vorgelegte Refresh-Token (existiert, kind=refresh, nicht abgelaufen)
 *   - invalidiert es SOFORT (Single-Use, Rotation-Pflicht fuer public clients)
 *   - stellt neues Access-Token (24h) + neues Refresh-Token aus
 *   - das neue Refresh-Token erbt das URSPRUENGLICHE absolute 120d-Ablaufdatum
 *     (KEIN sliding-Reset!)
 * Liefert null bei ungueltigem/abgelaufenem Refresh-Token
 *   -> Aufrufer (AUTH-3) gibt RFC6749 invalid_grant zurueck.
 */
export async function rotateRefresh(refreshToken: string): Promise<RotatedTokens | null> {
  if (!refreshToken) return null;
  const oldHash = hashToken(refreshToken);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Zeile sperren (FOR UPDATE) damit parallele Rotation desselben Tokens nicht doppelt feuert.
    const sel = await client.query<AuthTokenRow>(
      `SELECT token_hash, kind, client_id, scope, expires_at
         FROM auth_tokens
        WHERE token_hash = $1 AND kind = 'refresh'
        FOR UPDATE`,
      [oldHash],
    );
    const row = sel.rows[0];
    if (!row || (row.expires_at != null && row.expires_at.getTime() <= Date.now())) {
      await client.query('ROLLBACK');
      return null;
    }
    if (!row.client_id) {
      // Refresh ohne client_id ist inkonsistent -> ablehnen.
      await client.query('ROLLBACK');
      return null;
    }

    const absoluteExpiry = row.expires_at; // urspruengliches absolutes 120d-Datum erben
    const scope = row.scope ?? null;
    const clientId = row.client_id;

    // Altes Refresh-Token sofort invalidieren (Single-Use).
    await client.query('DELETE FROM auth_tokens WHERE token_hash = $1', [oldHash]);

    // Neues Access-Token (24h).
    const accessPlain = generateToken();
    await client.query(
      `INSERT INTO auth_tokens (token_hash, kind, client_id, scope, expires_at)
       VALUES ($1, 'access', $2, $3, $4)`,
      [hashToken(accessPlain), clientId, scope, new Date(Date.now() + ACCESS_TTL_MS)],
    );

    // Neues Refresh-Token mit GLEICHEM absolutem Ablauf.
    const refreshPlain = generateToken();
    await client.query(
      `INSERT INTO auth_tokens (token_hash, kind, client_id, scope, expires_at)
       VALUES ($1, 'refresh', $2, $3, $4)`,
      [hashToken(refreshPlain), clientId, scope, absoluteExpiry],
    );

    await client.query('COMMIT');

    return {
      access: { token: accessPlain, kind: 'access', clientId, scope, expiresAt: new Date(Date.now() + ACCESS_TTL_MS) },
      refresh: { token: refreshPlain, kind: 'refresh', clientId, scope, expiresAt: absoluteExpiry },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Widerruft ein einzelnes Token (per Klartext). Liefert true wenn etwas geloescht wurde. */
export async function revokeToken(token: string): Promise<boolean> {
  if (!token) return false;
  const pool = getPool();
  const res = await pool.query('DELETE FROM auth_tokens WHERE token_hash = $1', [hashToken(token)]);
  return (res.rowCount ?? 0) > 0;
}

/** Widerruft ALLE Tokens eines OAuth-Clients (Revoke pro Client). Liefert Anzahl. */
export async function revokeByClient(clientId: string): Promise<number> {
  if (!clientId) return 0;
  const pool = getPool();
  const res = await pool.query('DELETE FROM auth_tokens WHERE client_id = $1', [clientId]);
  return res.rowCount ?? 0;
}

/**
 * Listet Tokens (Metadaten, KEIN Klartext/Hash-Leak fuer UI noetig — wir geben
 * den Hash mit, damit die UI gezielt revoken kann). Optional nach kind/client gefiltert.
 */
export async function listTokens(filter?: { kind?: TokenKind; clientId?: string }): Promise<AuthTokenRow[]> {
  const pool = getPool();
  const conds: string[] = [];
  const args: unknown[] = [];
  if (filter?.kind) {
    args.push(filter.kind);
    conds.push(`kind = $${args.length}`);
  }
  if (filter?.clientId) {
    args.push(filter.clientId);
    conds.push(`client_id = $${args.length}`);
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const res = await pool.query<AuthTokenRow>(
    `SELECT token_hash, kind, client_id, scope, label, redirect_uri,
            code_challenge, parent_token, created_at, expires_at, last_used_at
       FROM auth_tokens ${where}
      ORDER BY created_at DESC`,
    args,
  );
  return res.rows;
}

/** Loescht abgelaufene Tokens (Wartung; optional von einem Cron/Hook aufrufbar). */
export async function purgeExpiredTokens(): Promise<number> {
  const pool = getPool();
  const res = await pool.query(
    'DELETE FROM auth_tokens WHERE expires_at IS NOT NULL AND expires_at <= NOW()',
  );
  return res.rowCount ?? 0;
}
