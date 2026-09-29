/**
 * Versionierte Kopie der Modellwahl-criteria fuer Jev (plan action 'empfehlen').
 *
 * QUELLE: Projekt JEV-Test, daten/modellwahl_criteria.json (Agent modell-recherche),
 *         Runde 2 "modular je Modell+Stufe", Stand 29.09.2026. Belege je Paar:
 *         herleitung_je_paar unten und daten/modellwahl_profile.json dort.
 * WARUM EINE KOPIE: die API soll nicht vom JEV-Test-Verzeichnis abhaengen.
 * PFLEGE: Inhalt 1:1 aus der Quelldatei uebernehmen (nicht hier redigieren) und
 *         KATALOG_STAND anpassen. scripts/test-jev-empfehlung.mjs vergleicht die Kopie
 *         mit der Quelle, wenn sie lesbar ist, und meldet Abweichungen.
 */

export const KATALOG_QUELLE = 'JEV-Test daten/modellwahl_criteria.json';
export const KATALOG_STAND = '2026-09-29 (Runde 2: modular je Modell+Stufe)';

export type KatalogGruppe = 'claude-abo' | 'codex-abo' | 'gemini-api';

export interface KatalogModell {
  gruppe: KatalogGruppe;
  /** Stufe -> englische Bedingung. 'default' = ohne Effort, 'none'/'minimal' = Stufen der Codex/Gemini-API */
  stufen: Record<string, string>;
}

export const MODELLWAHL_CRITERIA = {
  meta: {
    erstellt: '29.09.2026 (Runde 2: modular je Modell+Stufe)',
    agent: 'modell-recherche',
    grundlage: 'daten/modellwahl_profile.json (Benchmarks + Herstellerangaben, Quellen dort)',
    regeln_aus_readme: [
      'Fragen englisch, Zustand darf deutsch sein',
      'criteria schreiben die Bedingung aus statt den Namen zu wiederholen',
      'Jev rechnet nicht: Token-Zahlen, Kontingent-Prozente und Preise im Code in Kategorien uebersetzen',
      'Zustand klein halten',
      'Nouls filtern, Choice waehlt aus',
    ],
    ablauf: "1) Code setzt den Zustand (Kategorien). 2) Code-Vorfilter entfernt harte Ausschluesse. 3) Optional Choice 'task_category'. 4) Choice 'model' aus der gewaehlten Teilmenge (moeglichst <= 8 Paare). 5) Confidence-Tor (z. B. 0,5); darunter die guenstigste_ausreichende_wahl der Kategorie aus der Profildatei.",
    aufbau: "Synapse baut die Choice aus der Teilmenge 'kandidaten' (Standard: gruppe in [claude-abo, codex-abo]). Optionsname = '<alias>@<stufe>', criteria = der Bedingungstext. Jeder Text ist fuer sich allein verstaendlich und verweist auf keine andere Option.",
  },
  zustand_schema: {
    task: 'Aufgabentext (frei, darf deutsch sein)',
    context_need: 'fits in 200k tokens | between 200k and 272k tokens | more than 272k tokens',
    claude_quota: 'plenty | low | exhausted',
    codex_quota: 'plenty | low | exhausted',
    paid_api: 'allowed | not allowed',
    stakes: 'normal | critical',
    previous_attempt: 'none | failed with a smaller model',
  },
  vorfilter: {
    immer_raus_ausser_explizit_verlangt: {
      'gpt-5.5': 'Codex-Ruhestand 14.10.2026 (learn.chatgpt.com/docs/models); gemessen schwaecher als GPT-5.6 Sol (AA II 38 vs 47, TB4 14.6 vs 39.9) bei hoeheren Credits (125/750 vs 100/500).',
      'claude-fable-5': 'Legacy; Nachfolger claude-fable-5-1 gleicher Preis, ueberall besser gemessen (AA II 50 vs 53, TB4 42.4 vs 52.0).',
      'claude-opus-5': 'Legacy; Nachfolger claude-opus-5-5 billiger (4/20 vs 5/25) und besser (AA II 51 vs 58, TB4 49.0 vs 59.6).',
      'claude-sonnet-5': 'Legacy; claude-sonnet-5-5 gleicher Preis, AA II 38 vs 56, TB4 14.1 vs 63.6.',
      'claude-opus-4-8': 'Legacy; AA II 42, TB4 21.7 - von claude-opus-5-5 dominiert.',
      'claude-opus-4-7': 'Legacy; AA II 41 - von claude-opus-5-5 dominiert.',
      'claude-opus-4-6': 'Legacy; AA II 32 - von claude-opus-5-5 dominiert (auf LMArena Text/Coding allerdings weiter oben, Rang 2 bzw. 1).',
      'claude-sonnet-4-6': 'Legacy; teurer als Sonnet 5.5 (3/15 vs 2/10), AA II 30 vs 56.',
      'gemini-3.1-pro-preview': 'Preview; AA II 30 und TB4 4.0% bei 2/12 USD - gemessen schwaecher und teurer als gemini-3.8-flash (II 41, TB4 19.7%, 0.75/3.75).',
      'gemini-3.7-flash': 'Gleicher Preis wie gemini-3.8-flash, fast ueberall schwaecher; nur WebDev knapp vorn (1593 vs 1581, beide Preliminary).',
    },
    bedingt_raus: {
      'claude-haiku-4-5': "wenn context_need nicht 'fits in 200k tokens' (Kontext 200K)",
      'alle claude-*': 'wenn claude_quota = exhausted',
      'alle gpt-*': 'wenn codex_quota = exhausted',
      'alle gemini-*': 'wenn paid_api = not allowed',
      'gpt-*': "bei 'more than 272k tokens' steigt der Preis (models.dev tiers: z. B. Luna 0.4/1.8 statt 0.2/1.2) - Hinweis, kein Ausschluss",
    },
  },
  questions: {
    task_category: {
      type: 'choice',
      instructions: 'Classify the task described in the state by the kind of work it requires.',
      criteria: {
        heavy_agentic_coding: 'The task needs a long autonomous coding run: many files, several steps, running commands or tests in a terminal, and it is expected to take a long time.',
        routine_coding: 'The task is a clearly scoped code change: one bug fix, one feature, or tests, touching a few files.',
        large_refactor_or_codebase_reading: 'The task needs to read or change a large part of a codebase at once: a cross-cutting refactor, a migration across many modules, or understanding a big codebase.',
        code_review: 'The task is to judge an existing change: review a diff or patch, decide whether it fixes the problem, or find defects in given code.',
        frontend_ui: 'The task is to build or change a web frontend, user interface, page layout, or visual component.',
        research_or_writing: 'The task is to research a topic or write prose: documentation, a report, an explanation, or a summary for people.',
        mechanical: 'The task is simple and mechanical: renaming, extracting values, formatting, converting, or boilerplate, with no design decisions.',
        quick_answer_or_triage: 'The task asks for a short answer or a quick decision about where something belongs, with no code change.',
        tool_workflow: 'The task is to operate tools or services step by step to complete a business or operations workflow, not to write code.',
      },
    },
    model: {
      type: 'choice',
      instructions: 'Choose the model and effort level that should run this task. Prefer the least expensive option whose condition is fully met. Choose a stronger option only when the task clearly needs it.',
      criteria: "= { '<alias>@<stufe>': modelle[alias].stufen[stufe] } fuer alle Paare der Teilmenge 'kandidaten'",
    },
  },
  modelle: {
    'claude-opus-5-5': {
      gruppe: 'claude-abo',
      stufen: {
        low: 'The task is a clearly specified code change or a quick technical question that needs sound judgment but little exploration, the Claude quota is not exhausted, and a fast answer matters more than maximum thoroughness.',
        medium: 'The task is an everyday coding task, a code review of a normal diff, or research and writing that needs solid reasoning over several steps, and the Claude quota is not exhausted.',
        high: 'The task is long-running agentic coding across many files, a large cross-cutting refactor, hard debugging, frontend work where quality matters most, or a critical code review, and the Claude quota is not exhausted.',
        xhigh: 'The task is an autonomous build that is expected to run for an hour or more with many steps and self-checks, the result quality matters more than time and cost, and the Claude quota is plenty.',
      },
    },
    'claude-sonnet-5-5': {
      gruppe: 'claude-abo',
      stufen: {
        low: 'The task is a chat-style answer or a quick triage decision that must come back within seconds, with no code change, and the Claude quota is not exhausted.',
        medium: 'The task is a well-specified coding task or a multistep tool task with clear instructions, and the Claude quota is not exhausted.',
        high: 'The task is a frontend or UI change, or a harder coding task with several steps, and the Claude quota is not exhausted.',
        max: 'The task is the hardest kind of terminal or agentic coding work where the highest success rate matters and neither time nor quota is a concern, and the Claude quota is plenty.',
      },
    },
    'claude-fable-5-1': {
      gruppe: 'claude-abo',
      stufen: {
        high: 'The task is an agent session expected to run for hours, multistep deep research that must end in a finished document, or a task where an earlier attempt with a strong model already failed, and the Claude quota is plenty.',
      },
    },
    'claude-haiku-4-5': {
      gruppe: 'claude-abo',
      stufen: {
        default: 'The task is quick and mechanical, such as renaming, extracting values, formatting, adding log lines, or writing boilerplate, or it is a short triage answer, the input fits in 200k tokens, and the Claude quota is not exhausted.',
      },
    },
    'gpt-6-astra': {
      gruppe: 'codex-abo',
      stufen: {
        low: 'The task is a coding task or a terminal task of medium difficulty, or concise writing that must preserve facts, the Codex quota is not exhausted, and speed and low usage matter.',
        medium: 'The task is research and writing across many sources, or an ambitious project that needs broad context and a complete result, and the Codex quota is not exhausted.',
        high: 'The task is a hard coding or terminal task with several steps and tests to pass, the Codex quota is not exhausted, and solving it on the first attempt matters more than speed.',
        xhigh: 'The task is heavy agentic coding or terminal work at the hardest level, or a security or code review where thoroughness matters most, and the Codex quota is plenty.',
      },
    },
    'gpt-5.6-sol': {
      gruppe: 'codex-abo',
      stufen: {
        high: 'The task is a complex coding task or a tool-driven workflow, the Codex quota is low, and a mid-priced reasoning model is acceptable.',
      },
    },
    'gpt-5.6-terra': {
      gruppe: 'codex-abo',
      stufen: {
        none: 'The task is a short factual answer or a simple classification that must come back immediately, and no reasoning over several steps is needed, and the Codex quota is not exhausted.',
      },
    },
    'gpt-5.6-luna': {
      gruppe: 'codex-abo',
      stufen: {
        none: 'The task is a very simple classification, lookup, or yes-or-no triage that must be answered almost instantly at the lowest possible cost, and the Codex quota is not exhausted.',
        low: 'The task is a simple mechanical job such as a fine-grained edit, extraction, formatting, or conversion, with a clearly known correct result, and cost must be minimal.',
        xhigh: 'The task only needs to read, search, or summarize a large amount of text or code without making complex edits, and cost must be minimal.',
      },
    },
    'gemini-3.8-flash': {
      gruppe: 'gemini-api',
      stufen: {
        medium: 'Paid API use is allowed, and the task is research writing or routine coding where low cost matters more than the best possible quality.',
        high: 'Paid API use is allowed, and the task is a tool-driven business or operations workflow with many tool calls, where low cost matters.',
      },
    },
    'gemini-3.5-flash-lite': {
      gruppe: 'gemini-api',
      stufen: {
        minimal: 'Paid API use is allowed, and the task is a simple, high-volume mechanical job such as extraction, formatting, or classification, where the lowest cost and highest throughput matter most.',
      },
    },
  } as Record<string, KatalogModell>,
  herleitung_je_paar: {
    'claude-opus-5-5@low': 'AA 42, 0.55 USD, 1.4 min je Aufgabe; dominiert Sonnet 5.5 medium (AA 29.09.2026)',
    'claude-opus-5-5@medium': 'AA 51, 1.34 USD, 3.6 min; TB4 52.5% fuer 4.04 USD; Video yt_aicd_opus55: 0.56 USD/2 min je Coding-Prompt',
    'claude-opus-5-5@high': "TB4 56.6%, 5.12 USD, 13.6 min; WebDev Rang 1 (max); Hersteller 'large-scale refactoring'",
    'claude-opus-5-5@xhigh': 'TB4 59.6%, 8.78 USD, 21.8 min; Video yt_nate_effort: Sieger fuer 1,5-h-/goal; max bringt +0 Punkte fuer +49% Kosten',
    'claude-sonnet-5-5@low': "TTFT 1.04 s; Anthropic: 'For chat and other latency-sensitive work, start with medium or low'",
    'claude-sonnet-5-5@medium': "Anthropic: 'start with medium for well-specified tasks'; AA 41, 0.59 USD, 2.2 min",
    'claude-sonnet-5-5@high': 'WebDev Rang 4 (1699); AA 47, 1.08 USD',
    'claude-sonnet-5-5@max': 'TB4 63.6% (Hoechstwert aller Varianten), 18.76 USD, 29 min',
    'claude-fable-5-1@high': 'Anthropic: Fable erst, wenn Opus bei xhigh/max nicht reicht; AA: jede Fable-Stufe teurer als gleich gute Opus-Stufe',
    'claude-haiku-4-5@default': "Anthropic: 'Haiku for quick mechanical work'; AA 17, 0.28 USD; 200K Kontext; kein effort-Parameter",
    'gpt-6-astra@low': 'TB4 41.9%, 2.25 USD, 5 min, 5.37 USD je geloester Aufgabe (billigste >=30%); AA 46 mit 4k Tokens',
    'gpt-6-astra@medium': "Video yt_kashef_astra_effort: Recherche+Build 30 min, 10 M Tokens, gleichauf mit high/xhigh; Codex 'Astra · Medium: Ambitious projects ...'",
    'gpt-6-astra@high': 'TB4 54.0% fuer 4.05 USD, 10.1 min - besser UND billiger als medium (49.5%, 4.43 USD) bei Coding',
    'gpt-6-astra@xhigh': "TB4 59.6%, 5.86 USD, 14.4 min; OpenAI: xhigh 'security and code review'",
    'gpt-5.6-sol@high': 'AA 42, 0.81 USD; TB4 nur 20.7% - Rueckfallebene, wenn Astra nicht zur Wahl steht',
    'gpt-5.6-terra@none': 'AA 21, 0.14 USD, 0.6 min; TTFT 0.78 s (Non-reasoning)',
    'gpt-5.6-luna@none': 'AA 16, 0.01 USD, 0.3 min',
    'gpt-5.6-luna@low': "AA 21, 0.01 USD, 0.4 min; Codex 'Luna · Low: Fine-grained edits ... simple data extraction'",
    'gpt-5.6-luna@xhigh': 'AA 35, 0.09 USD, 3.4 min; AA-LCR 83.7 (bei max gemessen)',
    'gemini-3.8-flash@medium': 'AA 40, 0.93 USD (Default-Stufe); LMArena Text Rang 10',
    'gemini-3.8-flash@high': 'tau3-Banking 44.9% (Platz 2 aller Modelle), AA 41, 1.24 USD, 4.8 min',
    'gemini-3.5-flash-lite@minimal': "AA 22, 0.12 USD, 0.9 min (AA-Standardvariante); Google: 'fastest, most cost-effective 3.5 model'",
  },
  bewusst_weggelassene_paare: {
    'claude-opus-5-5@max': 'TB4 wie xhigh (59.6%), aber 13.11 statt 8.78 USD; Video: max schlechter als xhigh',
    'claude-sonnet-5-5@xhigh': 'von claude-opus-5-5@high dominiert (gleiche TB4-Quote, 42% billiger, 28% schneller)',
    'claude-fable-5-1@low/medium/xhigh/max': 'jede Stufe teurer als gleich gute Opus-5.5-Stufe',
    'gpt-6-astra@max': 'TB4 59.1% fuer 8.50 USD - teurer als xhigh (59.6%, 5.86 USD)',
    'gpt-5.6-sol@max': 'von gpt-6-astra@low dominiert',
    'gpt-5.5@*': 'Codex-Ruhestand 14.10.2026',
  },
};
