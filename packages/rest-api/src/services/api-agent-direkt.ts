/**
 * P22-T183 B4: Adapter der Toolschleife (core api-agent-schleife.ts) fuer den Lauf IM API-Prozess.
 * AnbieterDirekt: ruft den Provider-Transport in-process (api-agent-transport.ts: Reservierung, Freigabe, Buchung; Anthropic oder
 *   OpenRouter nach provider des Modells). Fehler werden zu ApiAnbieterFehler mit Fachcode, damit die Schleife ausdruecklich
 *   endet (kein Ersatzmodell). Merkt sich die Kontext-Tokens des letzten Aufrufs fuer die Kontextmessung je Lauf.
 * WerkzeugeDirekt: tools/list und tools/call ueber routes/mcp.ts apiLaufWerkzeugListe/-Aufruf (Gate, Profil, Audit wie beim
 *   tools/call mit Ausweis). Namen mit Praefix mcp__synapse__ wie beim Worker (Weck-Prompts nennen mcp__synapse__<tool>).
 */
import {
  ApiAnbieterFehler,
  type ApiAnbieterAdapter, type ApiAnbieterAnfrage, type ApiAnbieterAntwort, type ApiWerkzeugAusfuehrer, type ApiWerkzeugDef,
  type ApiTextBlock, type ApiBildBlock,
} from '@synapse/core';
import { rufeApiTransport, TransportFehler, type TransportKontext } from './api-agent-transport.js';
import { apiLaufWerkzeugListe, apiLaufWerkzeugAufruf, apiLaufZugang } from '../routes/mcp.js';

export const WERKZEUG_PRAEFIX = 'mcp__synapse__';

export class AnbieterDirekt implements ApiAnbieterAdapter {
  readonly name: string;
  /** Kontext-Tokens (Eingabe inkl. Cache) des letzten erfolgreichen Aufrufs; null = noch keiner. */
  letzterKontext: number | null = null;

  constructor(private readonly o: { kontext: TransportKontext; modell: string; anbieter: string; transport?: typeof rufeApiTransport }) {
    this.name = o.anbieter;
  }

  async rufe(a: ApiAnbieterAnfrage): Promise<ApiAnbieterAntwort> {
    try {
      const e = await (this.o.transport ?? rufeApiTransport)({
        kontext: this.o.kontext, modell: this.o.modell, system: a.system, max_tokens: a.max_tokens,
        verlauf: a.verlauf, werkzeuge: a.werkzeuge, signal: a.signal,
      });
      if (e.kontext_tokens !== null) this.letzterKontext = e.kontext_tokens;
      return e.antwort;
    } catch (err) {
      if (err instanceof ApiAnbieterFehler) throw err;
      if (err instanceof TransportFehler) throw new ApiAnbieterFehler(err.code, err.message, err.details, err.retryAfter ?? null);
      const code = (err as { code?: unknown })?.code;
      if (typeof code === 'string' && /^[a-z][a-z0-9_]{2,80}$/.test(code)) {
        // Fachfehler der Reservierung (funktion_aus, budget_erschoepft, api_freigabe_fehlt, preis_unbekannt, ...).
        throw new ApiAnbieterFehler(code, code, (err as { details?: unknown }).details);
      }
      throw err;
    }
  }
}

interface McpInhalt { type?: string; text?: string; data?: string; mimeType?: string }

export class WerkzeugeDirekt implements ApiWerkzeugAusfuehrer {
  private readonly zugang: ReturnType<typeof apiLaufZugang>;

  constructor(private readonly o: {
    identity_id: string; main: boolean; ausweis: string;
    /** Nur Tests: Ersatz fuer tools/list bzw. tools/call. */
    liste?: typeof apiLaufWerkzeugListe; aufruf?: typeof apiLaufWerkzeugAufruf;
  }) {
    this.zugang = apiLaufZugang(o.identity_id, o.main);
  }

  /** Gefilterte tools/list derselben Gate-Liste (F3: keine neuen Rechte). */
  async liste(): Promise<ApiWerkzeugDef[]> {
    const tools = await (this.o.liste ?? apiLaufWerkzeugListe)(this.o.ausweis, this.zugang);
    return tools.filter(t => typeof t.name === 'string' && t.name).map(t => ({
      name: WERKZEUG_PRAEFIX + t.name,
      beschreibung: t.description ?? '',
      schema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
    }));
  }

  async rufe(name: string, eingabe: Record<string, unknown>): Promise<{ inhalt: Array<ApiTextBlock | ApiBildBlock>; fehler: boolean }> {
    const werkzeug = name.startsWith(WERKZEUG_PRAEFIX) ? name.slice(WERKZEUG_PRAEFIX.length) : name;
    const r = (await (this.o.aufruf ?? apiLaufWerkzeugAufruf)(werkzeug, eingabe ?? {}, this.o.ausweis, this.zugang) ?? {}) as { content?: unknown; isError?: unknown };
    const inhalt: Array<ApiTextBlock | ApiBildBlock> = [];
    for (const c of (Array.isArray(r.content) ? r.content : []) as McpInhalt[]) {
      if (c.type === 'image' && typeof c.data === 'string' && typeof c.mimeType === 'string') inhalt.push({ typ: 'bild', media_type: c.mimeType, daten: c.data });
      else if (typeof c.text === 'string') inhalt.push({ typ: 'text', text: c.text });
      else inhalt.push({ typ: 'text', text: JSON.stringify(c) });
    }
    return { inhalt, fehler: r.isError === true };
  }
}
