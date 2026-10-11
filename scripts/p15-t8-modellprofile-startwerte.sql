-- P15-T8 (11.10.2026): STARTWERTE DER EMBEDDING-MODELLPROFILE (Tabelle embedding_modell_profile).
-- Bewusst KEIN Code-Default (Regel regel-keine-festverdrahteten-modellwerte): die Werte stehen hier
-- einmalig als Daten und werden danach nur noch ueber intern(modellprofil_setzen / _kalibrieren)
-- gepflegt. ON CONFLICT DO NOTHING: ein schon vorhandenes Profil wird NIE ueberschrieben.
--
-- AUSFUEHREN (Koordinator, NACH dem Deploy - ensureSchema legt die Tabelle an):
--   docker exec -i postgresql16 psql -U synapse -d synapse -v ON_ERROR_STOP=1 < scripts/p15-t8-modellprofile-startwerte.sql
-- PRUEFEN: intern(action:"modellprofil") -> aktiv.kalibriert true, fehlende_zwecke.
--
-- QWEN: die Werte, die bis P15-T8 als Zahlen im Code standen (nie fuer qwen nachgemessen, nur
-- uebernommen, damit ein Rueckwechsel auf qwen genauso laeuft wie vorher).
-- NEMOTRON: hook aus P15-T3 (thought 12ab4ab2), uebrige Schwellen gemessen am 11.10.2026
-- (thought P15-T8, Messwerte auch in messwerte). error_patterns und tech_docs_gut sind NICHT
-- gesetzt (nicht messbar: keine Tech-Docs eingebettet, kein Werkzeug fuer Pattern-Abfragen vor dem
-- Deploy) -> Fehlermuster-Warnungen und Context7-Nachladen bleiben aus, bis sie kalibriert sind:
--   intern(action:"modellprofil_kalibrieren", zweck:"error_patterns", passend:[...], rauschen:[...], schreiben:true)

BEGIN;

INSERT INTO embedding_modell_profile
  (modell, digest, query_praefix, dok_praefix, ziel_dimension, num_ctx, num_batch, max_stueck_zeichen,
   score_schwellen, kalibriert_am, kalibriert_von, notiz, messwerte)
VALUES (
  'qwen3-embedding:8b', '64b933495768',
  E'Instruct: Given a search query, retrieve relevant notes, decisions, code and documentation from a software project knowledge base that answer the query\nQuery: ',
  '',
  3072, 8192, 2048, 3276,
  '{"hook": 0.55, "channel_skill": 0.75, "channel_skill_abstand": 0.04, "graph_code": 0.55, "graph_wissen": 0.45,
    "error_patterns": 0.65, "global_search": 0.5, "tech_docs_gut": 0.60, "code_semantic_fallback": 0.65}'::jsonb,
  NOW(), 'p15-profil',
  'Startwerte P15-T8: bis 11.10.2026 als Zahlen im Code (qwen-Skala), nicht nachgemessen. Praefix laut Model-Card (P12-T4).',
  '{"herkunft": "aus dem Code uebernommen (graph.ts, error-patterns.ts, global-search.ts, tech-docs.ts, skill-hook.ts, code-intel.ts, Hook-awk)"}'::jsonb
)
ON CONFLICT (modell, digest) DO NOTHING;

INSERT INTO embedding_modell_profile
  (modell, digest, query_praefix, dok_praefix, ziel_dimension, num_ctx, num_batch, max_stueck_zeichen,
   score_schwellen, kalibriert_am, kalibriert_von, notiz, messwerte)
VALUES (
  'hf.co/zenmagnets/Nemotron-3-Embed-1B-Q4_K_M-GGUF:latest', 'b2a575f475dc',
  'query: ', 'passage: ',
  1024, 8192, 2048, 3276,
  '{"hook": 0.40, "channel_skill": 0.45, "channel_skill_abstand": 0.03, "graph_code": 0.36,
    "code_semantic_fallback": 0.36, "graph_wissen": 0.30, "global_search": 0.32}'::jsonb,
  NOW(), 'p15-profil',
  'Startwerte P15-T8. Praefixe laut Model-Card; num_batch 2048 = physischer Batch (Ablehnung ueber 2048 Token, P12-T14), 3276 Zeichen = 2048 x 1,6 (gemessen 3300 Zeichen TS = 981 Token). Schwellen: thought 12ab4ab2 (hook) und P15-T8-Thought.',
  '{"hook": {"am": "2026-10-11", "passend_min": 0.409, "rauschen_max": 0.379, "n_passend": 20, "n_rauschen": 8, "quelle": "thought 12ab4ab2"},
    "channel_skill": {"am": "2026-10-11", "passend_min": 0.415, "passend_median": 0.525, "rauschen_max": 0.417, "n_passend": 8, "n_rauschen": 6,
                      "hinweis": "ueberlappt knapp; 0.45 laesst 7/8 durch (SQL-EXPLAIN 0.415 nicht) und 0/6 Rauschen - bewusst strenger als hook"},
    "channel_skill_abstand": {"hinweis": "nicht gemessen, aus qwen 0.04 auf die engere Nemotron-Skala abgeleitet"},
    "code_semantic_fallback": {"am": "2026-10-11", "passend_min": 0.455, "passend_median": 0.62, "rauschen_max": 0.262, "n_passend": 6, "n_rauschen": 4},
    "graph_code": {"hinweis": "gleiche Collection/Skala wie code_semantic_fallback, nicht getrennt gemessen"},
    "graph_wissen": {"am": "2026-10-11", "passend": [0.522, 0.465, 0.409, 0.553, 0.313, 0.622], "rauschen_max": 0.222, "n_rauschen": 5},
    "global_search": {"hinweis": "aus code_semantic_fallback (Rauschen 0.262) und graph_wissen (Rauschen 0.222) abgeleitet"}}'::jsonb
)
ON CONFLICT (modell, digest) DO NOTHING;

SELECT modell, digest, query_praefix, dok_praefix, num_ctx, max_stueck_zeichen, score_schwellen
  FROM embedding_modell_profile ORDER BY modell;

COMMIT;
