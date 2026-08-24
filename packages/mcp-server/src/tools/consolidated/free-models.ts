/**
 * Synapse MCP - Consolidated free_models Tool
 *
 * Findet API-Modelle, die Synapse zusaetzlich zu Claude und Codex ansprechen
 * kann — vor allem die kostenlosen. Gedacht fuer zwei Faelle:
 *   1. Der Haupt-Agent soll auf Anweisung des Nutzers die Runtime wechseln.
 *   2. Eine erschoepfte CLI (Claude/Codex) braucht Ersatz und es soll ein
 *      passendes kostenloses Modell gewaehlt werden.
 *
 * Die Modelllisten sind NICHT gepflegt: sie kommen live aus den Katalogen der
 * Anbieter. Gepflegt wird nur die Endpunkt-Registry in
 * @synapse/core → services/free-model-pool.ts.
 *
 * GRENZE: Dieses Tool liest und schlaegt vor. Es schaltet nichts frei und
 * wechselt keine Runtime. Der Wechsel laeuft ueber die Runtime-Policy, sonst
 * koennte ein Agent sich selbst kostenpflichtige Modelle erlauben.
 */

import {
  searchPool,
  getPoolModel,
  getPoolProviders,
  getPoolSnapshot,
  loeseAliasAuf,
  listeAliase,
  probeProvider,
  type CostClass,
  type PoolModel,
} from '@synapse/core';

import { ConsolidatedTool, str, num, bool, strArray, reqStr } from './types.js';

/**
 * Kompakte Zeile fuer Listen. `usable` steht bewusst vorn: die Frage "kann ich
 * das aufrufen" entscheidet vor jeder Eigenschaft.
 */
function kompakt(modell: PoolModel): Record<string, unknown> {
  return {
    ref: modell.ref,
    usable: modell.reachability === 'ready' ? 'ja' : modell.reachability === 'unverified' ? 'ungeprueft' : 'nein',
    ...(modell.reachabilityNote ? { usable_note: modell.reachabilityNote } : {}),
    provider: modell.provider,
    cost: modell.costClass,
    context: modell.contextLength,
    max_output: modell.maxOutputTokens,
    capabilities: modell.capabilities,
    ...(modell.deprecated ? { deprecated: true } : {}),
    ...(modell.costClass === 'paid'
      ? { price_in_per_mtok: modell.priceInPerMTok, price_out_per_mtok: modell.priceOutPerMTok }
      : {}),
  };
}

/** Vollbild eines Modells inkl. allem, was fuer einen Aufruf noetig ist. */
function ausfuehrlich(modell: PoolModel): Record<string, unknown> {
  return {
    ref: modell.ref,
    provider: modell.provider,
    model_id: modell.modelId,
    name: modell.name ?? null,
    cost: modell.costClass,
    free_type: modell.freeType,
    price_in_per_mtok: modell.priceInPerMTok,
    price_out_per_mtok: modell.priceOutPerMTok,
    context: modell.contextLength,
    max_output: modell.maxOutputTokens,
    capabilities: modell.capabilities,
    input_modalities: modell.inputModalities,
    base_url: modell.baseUrl,
    wire_format: modell.wire,
    usable: modell.reachability,
    usable_note: modell.reachabilityNote,
    deprecated: modell.deprecated,
    // Leer heisst: der Anbieter kennt keine Abstufung. Ein trotzdem gesetzter
    // reasoning_effort quittiert er dann mit 400.
    reasoning_efforts: modell.reasoningEfforts,
    metadata_source: modell.metadataSource,
  };
}

function istKostenklasse(wert: string | undefined): wert is CostClass | 'any' {
  return wert === 'free' || wert === 'paid' || wert === 'unknown' || wert === 'any';
}

export const freeModelsTool: ConsolidatedTool = {
  definition: {
    name: 'free_models',
    description:
      'Findet API-Modelle, die Synapse neben Claude und Codex ansprechen kann — vor allem KOSTENLOSE. ' +
      'Nutze das Tool, wenn ein Abo/Kontingent erschoepft ist und Ersatz gebraucht wird, wenn der Nutzer ' +
      'nach verfuegbaren Modellen fragt, oder wenn fuer eine Aufgabe ein Modell mit bestimmten Eigenschaften ' +
      'gesucht wird (grosses Kontextfenster, Tool-Calling, Bildverstehen). ' +
      'Die Modelle kommen LIVE aus den Katalogen der Anbieter, es gibt keine gepflegte Liste. ' +
      'action="list" ist der Normalfall und zeigt standardmaessig NUR kostenlose Modelle; ' +
      'cost="any" nimmt kostenpflichtige dazu. ' +
      'Die Einordnung kennt drei Werte: "free" (kostenlos belegt), "paid" (Preis > 0) und ' +
      '"unknown" (der Anbieter nennt keine Preise — das ist KEINE Zusage von Kostenfreiheit). ' +
      'action="providers" zeigt, welche Anbieter eingerichtet sind und wo ein Schluessel fehlt. ' +
      'action="detail" liefert zu einem Modell alles, was fuer einen Aufruf noetig ist (Basis-URL, Modell-ID, Format). ' +
      'action="refresh" holt die Kataloge neu (sonst gilt ein Zwischenspeicher von 15 Minuten). '
      + 'Kontext, Kosten und Faehigkeiten stammen aus dem Katalog des Anbieters und werden, wo dieser schweigt, '
      + 'aus models.dev ergaenzt — das Feld metadata_source sagt, woher sie kommen. ' +
      'Jede Zeile traegt ein Feld usable: "ja" heisst belegt aufrufbar, "ungeprueft" heisst, dass der Katalog zwar ' +
      'oeffentlich lesbar ist, die Aufrufberechtigung aber nie bestaetigt wurde — solche Modelle koennen beim ersten ' +
      'echten Request mit 401/403 abbrechen. Bevorzuge usable="ja"; sonst vorher action="probe" mit dem Anbieter. ' +
      'Nachweislich nicht aufrufbare Modelle werden ausgeblendet (include_unusable=true zeigt sie mit Begruendung). ' +
      'WICHTIG: Das Tool waehlt nichts aus und schaltet nichts frei — es liefert Kandidaten. ' +
      'Der tatsaechliche Wechsel einer Runtime laeuft ueber die Runtime-Policy.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'detail', 'providers', 'probe', 'aliases', 'refresh'],
          description: 'Aktion: list | detail | providers | probe | aliases | refresh',
        },
        cost: {
          type: 'string',
          enum: ['free', 'paid', 'unknown', 'any'],
          description:
            "Kostenklasse (Standard 'free'). 'any' hebt den Filter auf. 'unknown' = Anbieter nennt keine Preise.",
        },
        provider: {
          type: 'string',
          description:
            'Bei list: nur Modelle dieses Anbieters, z.B. "openrouter". PFLICHT bei probe: welcher Anbieter geprueft wird. Namen liefert action="providers".',
        },
        query: {
          type: 'string',
          description: 'Freitext auf Modell-ID und Anzeigename, z.B. "glm", "nemotron", "code".',
        },
        min_context: {
          type: 'number',
          description: 'Nur Modelle mit mindestens so grossem Kontextfenster (in Token).',
        },
        capabilities: {
          type: 'array',
          items: { type: 'string', enum: ['tools', 'vision', 'reasoning', 'structured', 'audio'] },
          description:
            'Alle genannten Faehigkeiten muessen vorhanden sein. "tools" = Tool-Calling — fuer Agenten meist Pflicht.',
        },
        sort: {
          type: 'string',
          enum: ['context', 'name', 'price'],
          description: "Sortierung (Standard 'context', groesstes Kontextfenster zuerst).",
        },
        include_deprecated: {
          type: 'boolean',
          description: 'Abgekuendigte Modelle mitliefern (Standard false). Sie laufen oft noch, koennen aber jederzeit verschwinden.',
        },
        limit: { type: 'number', description: 'Max. Treffer (Standard 20, Obergrenze 200).' },
        ref: {
          type: 'string',
          description:
            'Pflicht fuer detail: Referenz "<anbieter>/<modell-id>", die blosse Modell-ID oder ein Kurzname '
            + 'wie "nemotron" oder "glm". Ein Kurzname bezeichnet die Familie, nicht die Fassung — aufgeloest wird '
            + 'auf das beste gerade verfuegbare Modell. Bekannte Kurznamen liefert action="aliases".',
        },
        include_unusable: {
          type: 'boolean',
          description:
            'Auch Modelle zeigen, deren Aufruf nachweislich scheitert (fehlendes Credential, abgelehnte Berechtigung). Standard false — solche Zeilen gehoeren normalerweise nicht in eine Auswahl.',
        },
        agent_id: { type: 'string', description: 'Agent-ID' },
      },
      required: ['action'],
    },
  },

  handler: async (args: Record<string, unknown>) => {
    const action = reqStr(args, 'action');

    switch (action) {
      case 'list': {
        const kosten = str(args, 'cost');
        const ergebnis = await searchPool({
          cost: istKostenklasse(kosten) ? kosten : 'free',
          provider: str(args, 'provider'),
          query: str(args, 'query'),
          minContext: num(args, 'min_context'),
          capabilities: strArray(args, 'capabilities'),
          includeDeprecated: bool(args, 'include_deprecated'),
          onlyReachable: bool(args, 'include_unusable') === true ? false : true,
          sort: (str(args, 'sort') as 'context' | 'name' | 'price' | undefined) ?? 'context',
          limit: num(args, 'limit'),
        });

        // Anbieter mit Problemen mitgeben: eine kurze Liste erklaert, warum
        // vielleicht weniger Modelle da sind als erwartet.
        const stille = ergebnis.providers
          .filter((p) => p.error !== null || p.reachability === 'blocked')
          .map((p) => ({ provider: p.id, grund: p.reachabilityNote ?? p.error }));

        const ungeprueft = ergebnis.models.filter((m) => m.reachability === 'unverified').length;

        return {
          success: true,
          count: ergebnis.models.length,
          matched: ergebnis.matched,
          total_catalog: ergebnis.total,
          fetched_at: ergebnis.fetchedAt,
          usable_ready: ergebnis.models.length - ungeprueft,
          usable_unverified: ungeprueft,
          models: ergebnis.models.map(kompakt),
          ...(stille.length ? { nicht_abrufbar: stille } : {}),
          hinweis:
            ergebnis.matched === 0
              ? 'Kein Treffer. Ohne passendes kostenloses Modell wird bewusst NICHT auf ein kostenpflichtiges ausgewichen — pruefe die Filter oder frage den Nutzer.'
              : 'Sortiert nach Nutzbarkeit, dann nach dem gewaehlten Kriterium. usable="ja" ist belegt aufrufbar; '
                + 'usable="ungeprueft" kann beim ersten echten Aufruf scheitern — dann vorher action="probe" fuer diesen Anbieter, '
                + 'oder ein Modell mit usable="ja" bevorzugen. Vor dem Aufruf action="detail" fuer Basis-URL und Modell-ID.',
        };
      }

      case 'detail': {
        const ref = reqStr(args, 'ref');
        const modell = await getPoolModel(ref);
        if (!modell) {
          return {
            success: false,
            error: `Modell "${ref}" nicht im Katalog. Mit action="list" suchen, oder action="aliases" fuer Kurznamen.`,
          };
        }
        // Bei einem Kurznamen die uebrigen Treffer nennen: der Aufrufer soll
        // sehen, dass es Alternativen gibt und welche gewaehlt wurde.
        const weitere = ref.toLowerCase() === modell.ref.toLowerCase()
          ? []
          : (await loeseAliasAuf(ref)).slice(1, 6).map((m) => m.ref);
        return {
          success: true,
          ...(weitere.length ? { aufgeloest_aus: ref, weitere_treffer: weitere } : {}),
          model: ausfuehrlich(modell),
          ...(modell.costClass !== 'free'
            ? {
                warnung:
                  modell.costClass === 'paid'
                    ? 'Kostenpflichtig. Nur nach ausdruecklicher Freigabe durch den Nutzer verwenden.'
                    : 'Kostenklasse unbekannt — der Anbieter nennt keine Preise. Nicht als kostenlos behandeln.',
              }
            : {}),
        };
      }

      case 'providers': {
        const anbieter = await getPoolProviders();
        return {
          success: true,
          count: anbieter.length,
          providers: anbieter.map((p) => ({
            id: p.id,
            label: p.label,
            free_type: p.freeType,
            usable: p.reachability,
            usable_note: p.reachabilityNote,
            probed_at: p.probedAt,
            credential: p.credentialPresent ? 'vorhanden' : p.envVar ? 'fehlt' : 'nicht noetig',
            env_var: p.envVar,
            models: p.modelCount,
            free_models: p.freeCount,
            error: p.error,
            ...(p.signupUrl ? { signup: p.signupUrl } : {}),
            ...(p.note ? { hinweis: p.note } : {}),
          })),
        };
      }

      case 'aliases': {
        const aliase = await listeAliase();
        return {
          success: true,
          count: aliase.length,
          aliases: aliase.slice(0, num(args, 'limit') ?? 40),
          hinweis:
            'Kurznamen bezeichnen eine Familie ohne Fassung. In action="detail" statt der vollen Referenz nutzbar; '
            + 'aufgeloest wird auf das beste verfuegbare Modell — kostenlos und aufrufbar zuerst.',
        };
      }

      case 'probe': {
        const providerId = reqStr(args, 'provider');
        const zustand = await probeProvider(providerId, str(args, 'ref'));
        return {
          success: true,
          provider: zustand.id,
          usable: zustand.reachability,
          usable_note: zustand.reachabilityNote,
          probed_at: zustand.probedAt,
          models: zustand.modelCount,
          free_models: zustand.freeCount,
          hinweis:
            zustand.reachability === 'ready'
              ? 'Aufruf bestaetigt. Die Modelle dieses Anbieters stehen jetzt mit usable="ja" in der Liste.'
              : 'Aufruf nicht moeglich. Die Modelle dieses Anbieters bleiben aus der Auswahl, bis sich das aendert.',
        };
      }

      case 'refresh': {
        const daten = await getPoolSnapshot(true);
        return {
          success: true,
          fetched_at: daten.fetchedAt,
          total_models: daten.models.length,
          free_models: daten.models.filter((m) => m.costClass === 'free').length,
          providers: daten.providers.map((p) => ({
            id: p.id,
            models: p.modelCount,
            free_models: p.freeCount,
            usable: p.reachability,
            error: p.error,
          })),
        };
      }

      default:
        throw new Error(`Unbekannte free_models action: "${action}"`);
    }
  },
};
