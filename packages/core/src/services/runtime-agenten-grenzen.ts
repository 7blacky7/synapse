/**
 * P22-T116 R8 (Abnahme 20a1192a/da3d601a): Fristen und Grenzen der Runtime-Agenten-Uebersicht/-Steuerung (T116) und des
 * Plattform-Modellwechsels (T117). Regel 7: Code-Standard + PG-Wert (Katalog runtime_ueberwachung, admin runtime_ueberwachung
 * modus setzen), Quelle sichtbar. 30 s gecacht; Lesefehler -> Code-Standard (quelle 'standard'). Kein ENV-Weg mehr.
 */
export const RUNTIME_AGENTEN_GRENZEN_STANDARD = {
  frist_ms: 10 * 60_000,
  offen_max: 50,
  job_warte_ms: 20_000,
  prozess_seiten_max: 5,
  log_max_bytes: 16_384,
  veraltet_ms: 10 * 60_000,
  stop_bestaetigen_sekunden: 5,
  modellwechsel_spawn_warte_ms: 90_000,
} as const;

export type RuntimeAgentenGrenzen = { -readonly [K in keyof typeof RUNTIME_AGENTEN_GRENZEN_STANDARD]: number } & { quelle: 'pg' | 'standard' };

let cache: { am: number; werte: RuntimeAgentenGrenzen } | null = null;

/** Rein, testbar: PG-Werte (runtime_ueberwachung) auf Grenzen abbilden; fehlende/ungueltige Werte -> Code-Standard. */
export function grenzenAusWerten(w: Record<string, unknown> | null): RuntimeAgentenGrenzen {
  const S = RUNTIME_AGENTEN_GRENZEN_STANDARD;
  if (!w) return { ...S, quelle: 'standard' };
  const z = (k: string, faktor: number, std: number) => { const n = Number(w[k]); return Number.isFinite(n) && n > 0 ? Math.floor(n * faktor) : std; };
  return {
    frist_ms: z('runtime_steuer_frist_minuten', 60_000, S.frist_ms),
    offen_max: z('runtime_steuer_offen_max', 1, S.offen_max),
    job_warte_ms: z('runtime_steuer_job_warte_sekunden', 1000, S.job_warte_ms),
    prozess_seiten_max: z('runtime_prozess_seiten_max', 1, S.prozess_seiten_max),
    log_max_bytes: z('runtime_log_max_bytes', 1, S.log_max_bytes),
    veraltet_ms: z('runtime_veraltet_minuten', 60_000, S.veraltet_ms),
    stop_bestaetigen_sekunden: z('runtime_stop_bestaetigen_sekunden', 1, S.stop_bestaetigen_sekunden),
    modellwechsel_spawn_warte_ms: z('runtime_modellwechsel_spawn_warte_sekunden', 1000, S.modellwechsel_spawn_warte_ms),
    quelle: 'pg',
  };
}

export async function leseRuntimeAgentenGrenzen(jetzt = Date.now(), frisch = false): Promise<RuntimeAgentenGrenzen> {
  if (!frisch && cache && jetzt - cache.am < 30_000) return cache.werte;
  let werte: RuntimeAgentenGrenzen;
  try {
    const { leseRuntimeUeberwachungWerte } = await import('./runtime-ueberwachung.js');
    werte = grenzenAusWerten(await leseRuntimeUeberwachungWerte() as unknown as Record<string, unknown>);
  } catch { werte = grenzenAusWerten(null); }
  cache = { am: jetzt, werte };
  return werte;
}

/** Synchroner Stand (letzter gelesener Wert bzw. Code-Standard) fuer reine Funktionen. */
export function runtimeAgentenGrenzenJetzt(): RuntimeAgentenGrenzen {
  return cache?.werte ?? grenzenAusWerten(null);
}
