/**
 * P22-T94: eigene Versionsnummer der Web-UI aus packages/web-ui/package.json (vite define beim Build).
 * Nicht die Synapse-/API-Version; der Deploy-Ablauf P17 erhoeht sie, wenn sich packages/web-ui geaendert hat.
 */
declare const __WEB_UI_VERSION__: string | undefined;

export const WEB_UI_VERSION: string = typeof __WEB_UI_VERSION__ === 'string' ? __WEB_UI_VERSION__ : 'dev';
