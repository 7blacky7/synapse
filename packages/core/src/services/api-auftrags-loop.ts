/** Wiederverwendbarer leichter In-API-Auftragsloop (A12/RV8), PG hält Lease und Zustand. */
export interface ApiAuftragsLoop {
  durchlauf(): Promise<void>;
  beende(): Promise<void>;
}
export function starteApiAuftragsLoop(o: { intervallMs: number; arbeit: () => Promise<void>; fehler: (e: unknown) => void }): ApiAuftragsLoop {
  if (!Number.isSafeInteger(o.intervallMs) || o.intervallMs < 1 || o.intervallMs > 2147483647) throw new TypeError('Ungültiges Auftragsintervall');
  let beendet = false;
  let laufend: Promise<void> | null = null;
  const durchlauf = (): Promise<void> => {
    if (beendet) return Promise.resolve();
    if (laufend) return laufend;
    laufend = Promise.resolve().then(o.arbeit).catch(o.fehler).finally(() => { laufend = null; });
    return laufend;
  };
  const timer = setInterval(() => { void durchlauf(); }, o.intervallMs);
  timer.unref();
  void durchlauf();
  return { durchlauf, beende: async () => { beendet = true; clearInterval(timer); await laufend; } };
}
