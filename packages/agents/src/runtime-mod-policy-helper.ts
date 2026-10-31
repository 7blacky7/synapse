#!/usr/bin/env node
/**
 * P22-T194 (t223-Nachbesserung, D0 2445a89d): ausfuehrbarer policyHelper des Runtime-Images
 * (/etc/claude-code/managed-settings.json -> /usr/local/bin/synapse-runtime-mod-policy). stdout enthaelt genau {managedSettings}.
 * SCHALTER: Nur wenn process.ts den CLI-Start als verwaltet markiert (SYNAPSE_RUNTIME_MOD_VERWALTET=1; nur bei
 *   runtime_synapse_mods EIN im API-Startstand und Image-Faehigkeit SYNAPSE_RUNTIME_MOD_POLICY=1), baut er die vollstaendige
 *   Synapse-Policy (Paketpruefung, allowManagedHooksOnly, eigene Mod, T190-Guard; runtime-mod-policy.ts).
 *   Sonst (Standard AUS, REST-Altstart, manuelle CLI-Aufrufe im Container) gibt er eine LEERE managed Policy aus: es gilt
 *   dasselbe wie ohne managed-settings.json, die Argumente des Aufrufers (--settings) wirken wie im Live-Stand.
 * Kein Netz, keine DB. @synapse/core wird nur im verwalteten Fall geladen. Fehler im verwalteten Fall: Exit 1 (kein offener
 * Rueckfall, die CLI startet dann nicht verwaltet-frei).
 * DEBUG: stderr [runtime-mod-policy] mit Revision/Version/Pfad (verwaltet) bzw. eine Zeile 'nicht verwaltet'.
 */
if (process.env.SYNAPSE_RUNTIME_MOD_VERWALTET !== '1') {
  console.error('[runtime-mod-policy] nicht verwaltet (runtime_synapse_mods AUS oder kein verwalteter Start): leere managed Policy');
  process.stdout.write(JSON.stringify({ managedSettings: {} }));
} else {
  import('./runtime-mod-policy.js')
    .then((m) => { process.stdout.write(JSON.stringify(m.runtimeModPolicyAusUmgebung())); })
    .catch((e: unknown) => {
      console.error('[runtime-mod-policy] verweigert: ' + (e instanceof Error ? e.message : String(e)));
      process.exitCode = 1;
    });
}
export {};
