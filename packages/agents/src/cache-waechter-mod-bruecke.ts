/**
 * P22-T194 / f18b99fb: schmale HTTP-Bruecke auf eigenem Unix-Socket.
 * Keine Inbox/Prompts/DB; Lauf kommt nur aus dem korrelierten CLI-Anmeldeergebnis.
 */
import { createServer, type ServerResponse } from 'node:http';
import { chmod, unlink } from 'node:fs/promises';
import { normalisiereCacheMessung, type CacheMessung } from '@synapse/core';
export interface CacheModDienste {
  bindung(): { sitzung: string; lauf_id: string | null; ab_ms: number };
  freigabe(): Promise<{ aktiv: boolean; quelle?: string; [key: string]: unknown }>;
  melden(m: { lauf_id: string; sitzung: string; messung: CacheMessung }): Promise<unknown>;
  log(s: string): void;
}
export async function starteCacheModBruecke(socket: string, d: CacheModDienste) {
  if (Buffer.byteLength(socket) > 100) throw Error('cache_mod_socket_pfad_zu_lang');
  const stand = { geladen: false, meldungen: 0, letzter_fehler: null as string | null };
  const antworte = (r: ServerResponse, code: number, body: unknown) => {
    r.writeHead(code, { 'content-type': 'application/json' }); r.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname !== '/cache-waechter') return antworte(res, 404, { success: false, error: 'route_unbekannt' });
      const b = d.bindung();
      if (req.method === 'GET') {
        if (!b.sitzung || url.searchParams.get('sitzung') !== b.sitzung) return antworte(res, 409, { success: false, error: 'cache_sitzung_falsch' });
        stand.geladen = true;
        const f = await d.freigabe();
        return antworte(res, 200, { success: true, ...f, aktiv: !!b.lauf_id && f.aktiv, generation: b.lauf_id, grund: b.lauf_id ? null : 'cache_laufbindung_fehlt' });
      }
      if (req.method !== 'POST') return antworte(res, 405, { success: false, error: 'methode_unbekannt' });
      let text = '';
      for await (const chunk of req) {
        text += chunk.toString();
        // Protokollobergrenze: ausschliesslich begrenzte Metadaten, nie Transcripttext.
        if (Buffer.byteLength(text) > 65536) return antworte(res, 413, { success: false, error: 'cache_metadaten_zu_gross' });
      }
      const body = JSON.parse(text) as { sitzung?: unknown; generation?: unknown; messung?: unknown };
      const aktuell = d.bindung();
      if (!aktuell.lauf_id || body.generation !== aktuell.lauf_id || body.sitzung !== aktuell.sitzung || aktuell.lauf_id !== b.lauf_id) {
        return antworte(res, 409, { success: false, error: 'cache_mod_lauf_falsch' });
      }
      const f = await d.freigabe();
      if (!f.aktiv) return antworte(res, 200, { success: true, angenommen: false, grund: 'schalter_aus' });
      const messung = normalisiereCacheMessung(body.messung);
      if (messung.request_beginn_ms === null || messung.request_beginn_ms < aktuell.ab_ms) return antworte(res, 409, { success: false, error: 'cache_mod_vor_anmeldung' });
      if (d.bindung().lauf_id !== aktuell.lauf_id) return antworte(res, 409, { success: false, error: 'cache_mod_lauf_falsch' });
      const r = await d.melden({ lauf_id: aktuell.lauf_id, sitzung: aktuell.sitzung, messung: { ...messung, erfassung: 'mod', zeitbasis: 'request_beginn' } });
      stand.meldungen++; stand.letzter_fehler = null;
      antworte(res, 200, r);
    })().catch(e => {
      stand.letzter_fehler = e instanceof Error ? e.message : String(e);
      d.log('cache-mod: ' + stand.letzter_fehler);
      if (!res.headersSent) antworte(res, 503, { success: false, error: 'cache_mod_meldung_fehler' });
      else res.end();
    });
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(socket, () => { server.off('error', fail); ok(); });
  });
  await chmod(socket, 0o600);
  server.on('error', e => { stand.letzter_fehler = e.message; d.log('cache-mod: ' + e.message); });
  return { status: () => ({ ...stand }), async stop() {
    server.closeAllConnections();
    await new Promise<void>(ok => server.close(() => ok()));
    await unlink(socket).catch(e => { if (e.code !== 'ENOENT') d.log('cache-mod: Socket nicht entfernbar'); });
  } };
}
