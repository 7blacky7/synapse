/**
 * Persistenz des Modell-Pools.
 *
 * Gespeichert wird nur, was Synapse selbst entscheidet oder beobachtet:
 * Freigaben, Sperren, Anbieterzustand, Verlauf. Der Modellkatalog bleibt eine
 * Spiegelung — er kommt jederzeit frisch vom Anbieter und ist niemals die
 * Quelle einer Entscheidung.
 *
 * Grundhaltung: **Ein Datenbankfehler darf die Modellsuche nie aufhalten.**
 * Jede Funktion hier schluckt ihre Fehler und meldet sie höchstens ins Log.
 * Ohne Datenbank arbeitet der Pool weiter, nur eben ohne Gedächtnis über einen
 * Neustart hinaus. Die einzige Ausnahme ist `setzeFreigabe`: eine Freigabe, die
 * stillschweigend nicht gespeichert wird, wäre eine gefährliche Lüge.
 */

import { randomUUID } from 'node:crypto';

import { getPool } from '../db/index.js';

export type Reachability = 'ready' | 'unverified' | 'blocked' | 'no_credential';

export interface GespeicherterAnbieter {
  id: string;
  reachability: Reachability;
  note: string | null;
  probedAt: string | null;
}

export interface GespeicherteSperre {
  ref: string;
  until: number;
  reason: string;
  message: string;
  failures: number;
}

export interface GespeicherterZustand {
  anbieter: GespeicherterAnbieter[];
  sperren: GespeicherteSperre[];
  /** ref → ausdrückliche Entscheidung; fehlt der Eintrag, gilt die Standardregel. */
  freigaben: Map<string, boolean>;
}

const LEER: GespeicherterZustand = { anbieter: [], sperren: [], freigaben: new Map() };

function warnen(was: string, fehler: unknown): void {
  console.warn('[free-pool] ' + was + ' fehlgeschlagen: ' + (fehler as Error).message);
}

/**
 * Liest den gemerkten Zustand. Wird einmal beim ersten Katalogaufbau gerufen —
 * danach lebt alles im Speicher und wird nur noch geschrieben.
 */
export async function ladeZustand(): Promise<GespeicherterZustand> {
  try {
    const pool = getPool();
    const [anbieter, sperren, freigaben] = await Promise.all([
      pool.query<{ id: string; reachability: Reachability; reachability_note: string | null; probed_at: Date | null }>(
        'SELECT id, reachability, reachability_note, probed_at FROM free_pool_providers',
      ),
      pool.query<{ ref: string; cooldown_until: Date; cooldown_reason: string | null; failure_count: number }>(
        'SELECT ref, cooldown_until, cooldown_reason, failure_count FROM free_pool_models WHERE cooldown_until > NOW()',
      ),
      pool.query<{ ref: string; allowed: boolean }>(
        'SELECT ref, allowed FROM free_pool_models WHERE allowed IS NOT NULL',
      ),
    ]);

    return {
      anbieter: anbieter.rows.map((zeile) => ({
        id: zeile.id,
        reachability: zeile.reachability,
        note: zeile.reachability_note,
        probedAt: zeile.probed_at ? zeile.probed_at.toISOString() : null,
      })),
      sperren: sperren.rows.map((zeile) => ({
        ref: zeile.ref,
        until: zeile.cooldown_until.getTime(),
        reason: zeile.cooldown_reason ?? 'unknown',
        message: '',
        failures: zeile.failure_count,
      })),
      freigaben: new Map(freigaben.rows.map((zeile) => [zeile.ref, zeile.allowed])),
    };
  } catch (fehler) {
    warnen('Zustand laden', fehler);
    return LEER;
  }
}

/** Hält den beobachteten Anbieterzustand fest. */
export async function speichereAnbieter(
  id: string,
  reachability: Reachability,
  note: string | null,
  geprueft: boolean,
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO free_pool_providers (id, reachability, reachability_note, probed_at, updated_at)
       VALUES ($1, $2, $3, CASE WHEN $4 THEN NOW() ELSE NULL END, NOW())
       ON CONFLICT (id) DO UPDATE SET
         reachability = EXCLUDED.reachability,
         reachability_note = EXCLUDED.reachability_note,
         probed_at = COALESCE(EXCLUDED.probed_at, free_pool_providers.probed_at),
         updated_at = NOW()`,
      [id, reachability, note, geprueft],
    );
  } catch (fehler) {
    warnen('Anbieterzustand speichern', fehler);
  }
}

/** Schreibt eine Sperre. Legt die Modellzeile an, falls die Synchronisierung noch nicht lief. */
export async function speichereSperre(
  ref: string,
  provider: string,
  modelId: string,
  bis: Date,
  grund: string,
  fehlversuche: number,
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO free_pool_models (ref, provider, model_id, cooldown_until, cooldown_reason, failure_count, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (ref) DO UPDATE SET
         cooldown_until = EXCLUDED.cooldown_until,
         cooldown_reason = EXCLUDED.cooldown_reason,
         failure_count = EXCLUDED.failure_count,
         updated_at = NOW()`,
      [ref, provider, modelId, bis, grund, fehlversuche],
    );
  } catch (fehler) {
    warnen('Sperre speichern', fehler);
  }
}

/** Hebt eine Sperre auf und hält den erfolgreichen Aufruf fest. */
export async function loescheSperre(ref: string): Promise<void> {
  try {
    await getPool().query(
      `UPDATE free_pool_models
          SET cooldown_until = NULL, cooldown_reason = NULL, failure_count = 0,
              last_ok_at = NOW(), updated_at = NOW()
        WHERE ref = $1`,
      [ref],
    );
  } catch (fehler) {
    warnen('Sperre aufheben', fehler);
  }
}

export interface ModellZeile {
  ref: string;
  provider: string;
  modelId: string;
  displayName: string | null;
  family: string | null;
  costClass: string;
  priceIn: number | null;
  priceOut: number | null;
  contextLength: number | null;
  maxOutputTokens: number | null;
  capabilities: string[];
  deprecated: boolean;
  metadataSource: string | null;
}

/**
 * Gleicht den erkannten Katalog mit der Datenbank ab.
 *
 * Verschwundene Modelle werden als `stale` markiert, **nicht gelöscht**: sonst
 * geht die Freigabe verloren, wenn ein Modell zurückkommt — und genau das
 * passiert bei Anbietern mit wechselndem Angebot ständig.
 * `allowed` und `data_use` bleiben unangetastet, das sind unsere Entscheidungen.
 */
export async function synchronisiereModelle(modelle: ModellZeile[]): Promise<void> {
  if (modelle.length === 0) return;
  const pool = getPool();
  const client = await pool.connect().catch((fehler) => {
    warnen('Verbindung für Katalogabgleich', fehler);
    return null;
  });
  if (!client) return;

  try {
    await client.query('BEGIN');
    // Feste Reihenfolge: greifen zwei Transaktionen dieselben Zeilen in
    // unterschiedlicher Folge an, blockieren sie einander wechselseitig.
    const sortiert = [...modelle].sort((a, b) => a.ref.localeCompare(b.ref));
    for (const modell of sortiert) {
      await client.query(
        `INSERT INTO free_pool_models
           (ref, provider, model_id, display_name, family, cost_class, price_in_per_mtok,
            price_out_per_mtok, context_length, max_output_tokens, capabilities, deprecated,
            metadata_source, stale, last_seen_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,FALSE,NOW(),NOW())
         ON CONFLICT (ref) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           family = EXCLUDED.family,
           cost_class = EXCLUDED.cost_class,
           price_in_per_mtok = EXCLUDED.price_in_per_mtok,
           price_out_per_mtok = EXCLUDED.price_out_per_mtok,
           context_length = EXCLUDED.context_length,
           max_output_tokens = EXCLUDED.max_output_tokens,
           capabilities = EXCLUDED.capabilities,
           deprecated = EXCLUDED.deprecated,
           metadata_source = EXCLUDED.metadata_source,
           stale = FALSE,
           last_seen_at = NOW(),
           updated_at = NOW()`,
        [
          modell.ref, modell.provider, modell.modelId, modell.displayName, modell.family,
          modell.costClass, modell.priceIn, modell.priceOut, modell.contextLength,
          modell.maxOutputTokens, modell.capabilities, modell.deprecated, modell.metadataSource,
        ],
      );
    }

    // Was diesmal nicht dabei war, ist verschwunden — aber nur bei den
    // Anbietern, die tatsaechlich geantwortet haben. Sonst wuerde ein
    // Netzausfall den halben Katalog als verschwunden markieren.
    const anbieter = [...new Set(modelle.map((m) => m.provider))];
    const refs = modelle.map((m) => m.ref);
    await client.query(
      `UPDATE free_pool_models
          SET stale = TRUE, updated_at = NOW()
        WHERE provider = ANY($1) AND NOT (ref = ANY($2)) AND stale = FALSE`,
      [anbieter, refs],
    );
    await client.query('COMMIT');
  } catch (fehler) {
    await client.query('ROLLBACK').catch(() => undefined);
    warnen('Katalogabgleich', fehler);
  } finally {
    client.release();
  }
}

/**
 * Setzt eine ausdrückliche Freigabe. `null` nimmt die Entscheidung zurück,
 * dann gilt wieder die Standardregel (kostenlos ja, alles andere nein).
 *
 * Wirft im Fehlerfall — im Gegensatz zum Rest dieser Datei. Wer eine Freigabe
 * erteilt und keine Fehlermeldung sieht, muss sich darauf verlassen können,
 * dass sie auch gespeichert ist.
 */
export async function setzeFreigabe(ref: string, erlaubt: boolean | null, grund?: string): Promise<void> {
  const ergebnis = await getPool().query(
    'UPDATE free_pool_models SET allowed = $2, updated_at = NOW() WHERE ref = $1',
    [ref, erlaubt],
  );
  if ((ergebnis.rowCount ?? 0) === 0) {
    throw new Error(
      'Modell "' + ref + '" ist nicht im gespeicherten Katalog. Erst einen Katalogabgleich auslösen.',
    );
  }
  await protokolliere('allowed_changed', { ref, detail: { allowed: erlaubt, grund: grund ?? null } });
}

/** Setzt die Datenverwendung eines Modells und damit die höchste erlaubte Rolle. */
export async function setzeDatenverwendung(
  ref: string,
  verwendung: 'private' | 'retained' | 'training' | 'unknown',
): Promise<void> {
  const ergebnis = await getPool().query(
    'UPDATE free_pool_models SET data_use = $2, updated_at = NOW() WHERE ref = $1',
    [ref, verwendung],
  );
  if ((ergebnis.rowCount ?? 0) === 0) throw new Error('Modell "' + ref + '" ist nicht im gespeicherten Katalog.');
}

/** Schreibt einen Eintrag ins Änderungsprotokoll. */
export async function protokolliere(
  kind: string,
  daten: { provider?: string; ref?: string; detail?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    await getPool().query(
      'INSERT INTO free_pool_events (kind, provider, ref, detail) VALUES ($1,$2,$3,$4)',
      [kind, daten.provider ?? null, daten.ref ?? null, daten.detail ? JSON.stringify(daten.detail) : null],
    );
  } catch (fehler) {
    warnen('Protokolleintrag', fehler);
  }
}

/** Die letzten Einträge des Änderungsprotokolls. */
export async function leseProtokoll(limit = 50): Promise<Array<Record<string, unknown>>> {
  try {
    const ergebnis = await getPool().query(
      'SELECT id, at, kind, provider, ref, detail FROM free_pool_events ORDER BY at DESC, id DESC LIMIT $1',
      [Math.min(Math.max(limit, 1), 500)],
    );
    return ergebnis.rows;
  } catch (fehler) {
    warnen('Protokoll lesen', fehler);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Zugangsdaten
// ---------------------------------------------------------------------------

export interface CredentialZeile {
  id: string;
  provider: string;
  label: string;
  source: 'env' | 'database' | 'manual';
  secretRef: string | null;
  hasPaymentMethod: boolean;
  priority: number;
  enabled: boolean;
}

/**
 * Alle hinterlegten Zugänge eines Anbieters, beste Priorität zuerst.
 * Der Schlüssel selbst wird hier NICHT mitgegeben — dafür gibt es
 * `leseCredentialGeheimnis`, damit ein Versehen beim Weiterreichen von
 * Listen keine Schlüssel verteilt.
 */
export async function listeCredentials(provider?: string): Promise<CredentialZeile[]> {
  try {
    const ergebnis = await getPool().query(
      `SELECT id, provider, label, source, secret_ref, has_payment_method, priority, enabled
         FROM free_pool_credentials
        WHERE enabled = TRUE AND ($1::text IS NULL OR provider = $1)
        ORDER BY provider, priority, label`,
      [provider ?? null],
    );
    return ergebnis.rows.map((zeile) => ({
      id: zeile.id,
      provider: zeile.provider,
      label: zeile.label,
      source: zeile.source,
      secretRef: zeile.secret_ref,
      hasPaymentMethod: zeile.has_payment_method,
      priority: zeile.priority,
      enabled: zeile.enabled,
    }));
  } catch (fehler) {
    warnen('Zugänge lesen', fehler);
    return [];
  }
}

/** Löst einen Zugang zum tatsächlichen Schlüssel auf: erst die Quelle, dann das Klartextfeld. */
export async function leseCredentialGeheimnis(id: string): Promise<string | null> {
  try {
    const ergebnis = await getPool().query<{ secret_ref: string | null; api_key: string | null }>(
      'SELECT secret_ref, api_key FROM free_pool_credentials WHERE id = $1 AND enabled = TRUE',
      [id],
    );
    const zeile = ergebnis.rows[0];
    if (!zeile) return null;
    if (zeile.secret_ref) {
      const ausUmgebung = process.env[zeile.secret_ref];
      if (ausUmgebung && ausUmgebung.trim()) return ausUmgebung.trim();
    }
    return zeile.api_key && zeile.api_key.trim() ? zeile.api_key.trim() : null;
  } catch (fehler) {
    warnen('Zugang auflösen', fehler);
    return null;
  }
}

/** Legt einen Zugang an oder aktualisiert ihn. Der Schlüssel selbst ist optional. */
export async function speichereCredential(eingabe: {
  provider: string;
  label: string;
  secretRef?: string | null;
  apiKey?: string | null;
  hasPaymentMethod: boolean;
  priority?: number;
}): Promise<string> {
  const id = randomUUID();
  const ergebnis = await getPool().query<{ id: string }>(
    `INSERT INTO free_pool_credentials (id, provider, label, source, secret_ref, api_key, has_payment_method, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (provider, label) DO UPDATE SET
       source = EXCLUDED.source,
       secret_ref = EXCLUDED.secret_ref,
       api_key = COALESCE(EXCLUDED.api_key, free_pool_credentials.api_key),
       has_payment_method = EXCLUDED.has_payment_method,
       priority = EXCLUDED.priority,
       updated_at = NOW()
     RETURNING id`,
    [
      id,
      eingabe.provider,
      eingabe.label,
      eingabe.secretRef ? 'env' : eingabe.apiKey ? 'database' : 'manual',
      eingabe.secretRef ?? null,
      eingabe.apiKey ?? null,
      eingabe.hasPaymentMethod,
      eingabe.priority ?? 0,
    ],
  );
  await protokolliere('credential_changed', {
    provider: eingabe.provider,
    detail: { label: eingabe.label, quelle: eingabe.secretRef ? 'env' : 'datenbank' },
  });
  return ergebnis.rows[0].id;
}
