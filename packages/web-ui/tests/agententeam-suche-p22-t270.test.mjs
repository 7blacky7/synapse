/**
 * P22-T270: Agententeam als Suche mit „Ausweis erstellen“ und Ausweis-Fenster - ohne DB, Netz und Browser.
 *   node --experimental-strip-types packages/web-ui/tests/agententeam-suche-p22-t270.test.mjs
 * Herkunft: User thought 9ddef22c (Suche, Fenster, Bearbeiten, Channel-Icon) + Nachtrag 7b25b0c1 (erster Eintrag „Ausweis erstellen“).
 * Sichert ab:
 *   A views/projekt/agententeam-suche-logik.ts: Suche/Reihenfolge, Felder nur aus dem bestehenden Ausweis-Profil, Patch nur geaenderter
 *     Felder (leer = null, Listen zeilenweise), Channel zuweisen/entziehen, Rueckfall-Zeile fuer neu angelegte Identitaeten.
 *   B components/AgentenTeamSuche.tsx: gleiche Bedienung/Klassen wie ChannelSuche, „Ausweis erstellen“ steht VOR den Treffern.
 *   C components/AusweisFenster.tsx: Fenster-Klassen des Channel-Fensters, vorhandene Wege stelleAus/ladeDetail/speichereProfil
 *     (P22-T68), Channel-Icon, keine Laufwahl aus dem offenen P22-T202.
 *   D SynapseWorkspace.tsx + core agent-profil-schalter.ts: Produkt-Schalter web_ui_agententeam_suche, Standard AUS, nur ausdruecklich,
 *     Debug-Attribute; AUS = bisheriger Agententeam-Knopf.
 *   E agententeam-suche-p22-t270.css: nur Theme-Variablen, Ecken <= 3px, Fokusrahmen, reduced-motion.
 * Bei Fehlschlag: 'DEBUG <Herkunft> | tatsaechlich ...'.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUSWEIS_ERSTELLEN, AUSWEIS_FELDER, agentAusIdentitaet, entwurfAusWerten, fehlendeFelder, patchAusEntwurf, sortiereTeamSuche, umschalteChannel } from '../src/views/projekt/agententeam-suche-logik.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
let checks = 0;
const kurz = (v) => { try { return JSON.stringify(v).slice(0, 600); } catch { return String(v).slice(0, 600); } };
const ok = (wert, label, info) => { checks++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + kurz(info) : '')); assert(wert, label); console.log('OK ' + label); };

// ---------------------------------------------------------------- A Logik
const L = 'P22-T270 agententeam-suche-logik.ts';
const a = (name, extra = {}) => ({ name, agentId: name, model: '', status: 'offline', contextPercent: 0, tokensIn: 0, tokensOut: 0, channels: [], currentTask: '', busy: false, provider: '', lastActivity: '', source: 'api', ...extra });
const team = [a('zeta'), a('beta', { status: 'angemeldet' }), a('alpha', { busy: true, status: 'running' }), a('gamma', { rolle: 'koordinator', status: 'idle' })];
ok(AUSWEIS_ERSTELLEN === 'Ausweis erstellen', L + ': Text des ersten Eintrags');
ok(kurz(sortiereTeamSuche(team, '').map((x) => x.name)) === kurz(['alpha', 'beta', 'gamma', 'zeta']), L + ' sortiereTeamSuche: arbeitend, angemeldet, idle, Rest; dann Name', sortiereTeamSuche(team, '').map((x) => x.name));
ok(kurz(sortiereTeamSuche(team, 'KOORD').map((x) => x.name)) === kurz(['gamma']), L + ' sortiereTeamSuche: findet Rolle ohne Gross-/Kleinschreibung');
ok(team.map((x) => x.name).join() === 'zeta,beta,alpha,gamma', L + ' sortiereTeamSuche: Eingabe unveraendert');
const w = { modell: 'opus', effort: '', kontextStufe: 'kompakt', briefing: 'Alt', arbeitsweise: '', regeln: ['r1', 'r2'], skills: [], channels: ['a'], erlaubteModelle: [], erlaubteRuntimes: [] };
ok(kurz(AUSWEIS_FELDER.map((f) => f.schluessel)) === kurz(['modell', 'effort', 'kontext_stufe', 'briefing', 'arbeitsweise', 'regeln', 'skills']), L + ' AUSWEIS_FELDER: nur bestehende Profilfelder (wie AusweisIdentitaetenPanel patchAus), Channels getrennt');
const e = entwurfAusWerten(w);
ok(kurz(Object.keys(e)) === kurz(['modell', 'kontext_stufe', 'briefing', 'regeln']) && e.regeln === 'r1\nr2', L + ' entwurfAusWerten: nur belegte Felder, Listen zeilenweise', e);
ok(kurz(fehlendeFelder(e).map((f) => f.schluessel)) === kurz(['effort', 'arbeitsweise', 'skills']), L + ' fehlendeFelder: zum Hinzufuegen');
ok(kurz(patchAusEntwurf(w, e)) === '{}', L + ' patchAusEntwurf: unveraendert = leerer Patch');
const p = patchAusEntwurf(w, { ...e, briefing: '', regeln: 'r1\n\n r2 \nr3', skills: 'synapse-agent-regeln', kontext_stufe: 'minimal', modell: 'opus' });
ok(kurz(p) === kurz({ kontext_stufe: 'minimal', briefing: null, regeln: ['r1', 'r2', 'r3'], skills: ['synapse-agent-regeln'] }), L + ' patchAusEntwurf: leer = null, Listen getrimmt, Auswahl nur mit Wert', p);
ok(kurz(patchAusEntwurf(w, { ...e, kontext_stufe: '' })) === '{}', L + ' patchAusEntwurf: leere Kontextstufe wird nicht gesendet (wie patchAus)');
ok(kurz(umschalteChannel(['a', 'b'], 'a')) === kurz(['b']) && kurz(umschalteChannel(['b'], 'c')) === kurz(['b', 'c']), L + ' umschalteChannel: entziehen bzw. anhaengen');
const r = agentAusIdentitaet({ identityId: 'i1', agentId: 'neu', rolle: 'subagent', status: 'aktiv' });
ok(r.key === 'identity:i1' && r.art === 'identitaet' && r.identityId === 'i1' && Array.isArray(r.channels) && r.source === 'api', L + ' agentAusIdentitaet: vollstaendige Teamzeile (Schluessel wie agenten-team)', r);

// ---------------------------------------------------------------- B Suche
const S = 'packages/web-ui/src/components/AgentenTeamSuche.tsx', s = lies(S);
ok(/className="seitenleiste-projektsuche channel-suche agententeam-suche"/.test(s) && /channel-suche-liste/.test(s), 'P22-T270 ' + S + ': Klassen der Channel-/Projektsuche (gleiche Bedienung)');
ok(/aria-haspopup="dialog"/.test(s) && /e\.key === 'Escape'/.test(s) && /pointerdown/.test(s), 'P22-T270 ' + S + ': Escape und Klick daneben schliessen wie ChannelSuche');
const iErst = s.indexOf('agententeam-suche-erstellen'), iListe = s.indexOf('liste.map(');
ok(iErst > 0 && iListe > iErst, 'P22-T270 ' + S + ': „Ausweis erstellen“ steht vor den Projektagenten', { iErst, iListe });
ok(/modus: 'anlegen'/.test(s) && /modus: 'anzeigen'/.test(s) && /loadProjectTeamViewModels\(project\)/.test(s), 'P22-T270 ' + S + ': Anlege-Modus fuer das gewaehlte Projekt, Agenten aus agenten-team');

// ---------------------------------------------------------------- C Fenster
const F = 'packages/web-ui/src/components/AusweisFenster.tsx', f = lies(F);
ok(/'channel-eigenfenster ausweis-fenster'/.test(f) && /channel-eigenfenster-kopf/.test(f) && /setPointerCapture/.test(f) && /Minimieren/.test(f), 'P22-T270 ' + F + ': Fenster-Komponente wie Channel-Fenster (Ziehen, Minimieren, Schliessen)');
ok(/stelleAus\(project, \{ name: n, rolle, grund/.test(f), 'P22-T270 ' + F + ': Anlegen ueber vorhandenes stelleAus (P22-T68, nichts doppelt gebaut)');
ok(/ladeDetail\(project, identityId\)/.test(f) && (f.match(/speichereProfil\(/g) || []).length >= 2, 'P22-T270 ' + F + ': Bearbeiten und Channels ueber ladeDetail/speichereProfil (CAS-Revision)');
ok(/aria-label=\{'Channels zuweisen/.test(f) && /umschalteChannel\(zugewiesen, name\)/.test(f), 'P22-T270 ' + F + ': Channel-Icon weist zu und entzieht');
ok(/TeamAusweisKarte/.test(f) && /AktuelleTaskAbsatz/.test(f) && /Letzte Anmeldung/.test(f) && /Tokens \(Monat, Abo\)/.test(f), 'P22-T270 ' + F + ': Inhalt der Agententeam-Seite (Ausweis-Karte, Task, Fakten)');
ok(!/ApiAgentLaufwahl/.test(f.replace(/\/\*[\s\S]*?\*\//g, '')), 'P22-T270 ' + F + ': keine Laufwahl aus dem offenen P22-T202');
ok(/data-modus=\{ziel\.modus\}/.test(f) && /data-profil=/.test(f) && /data-revision=/.test(f), 'P22-T270 ' + F + ': Debug-Attribute');

const AV = 'packages/web-ui/src/api/ausweis-verwaltung.ts', av = lies(AV);
ok(/modell: str\(i\.modell_bestaetigt\) \|\| str\(roh\.modell\)/.test(av), 'P22-T270 ' + AV + ' ladeDetail: Profil-Modell (modell_bestaetigt) vor geerbtem Modell, fuer Panel und Fenster gleich');
ok(/const ansicht = detail;/.test(f) && !/modellBestaetigt/.test(f), 'P22-T270 ' + F + ': kein eigener Modell-Rueckfall, Wert kommt aus ladeDetail');

// ---------------------------------------------------------------- D Schalter
const W = 'packages/web-ui/src/components/workspace/SynapseWorkspace.tsx', ws = lies(W);
ok(/leseArbeitsbereichSchalter\(selectedProject,'web_ui_agententeam_suche'\)/.test(ws), 'P22-T270 ' + W + ': liest Produkt-Schalter web_ui_agententeam_suche');
ok(/item\.area === 'agents' && agententeamSuche\?\.aktiv \? <AgentenTeamSuche/.test(ws), 'P22-T270 ' + W + ': Suche nur mit Schalter EIN, sonst bisheriger Knopf');
ok(/<AusweisFensterProvider>/.test(ws) && /data-agententeam-suche=\{agententeamSuche\?\.aktiv \? 'ein' : 'aus'\}/.test(ws), 'P22-T270 ' + W + ': Fenster-Host und Debug-Attribut');
const K = 'packages/core/src/services/agent-profil-schalter.ts', k = lies(K);
ok(/\n  'web_ui_agententeam_suche',\n/.test(k), 'P22-T270 ' + K + ': Schalter im Funktionskatalog');
ok(/NUR_AUSDRUECKLICH: readonly string\[\] = \[[^\]]*'web_ui_agententeam_suche'/.test(k), 'P22-T270 ' + K + ': nur ausdruecklich (Standard AUS, nicht ueber alle)');

// ---------------------------------------------------------------- E CSS
const C = 'packages/web-ui/src/agententeam-suche-p22-t270.css', css = lies(C).replace(/\/\*[\s\S]*?\*\//g, '');
ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(css), 'P22-T270 ' + C + ': keine festen Farben', css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g));
ok(!/var\(--[a-z0-9-]+,/.test(css), 'P22-T270 ' + C + ': keine Fallbacks in var()');
const radien = [...css.matchAll(/border-radius:([0-9.]+)px/g)].map((m) => Number(m[1]));
ok(radien.every((x) => x <= 3), 'P22-T270 ' + C + ': Ecken <= 3px (Punkte nutzen 50%)', radien);
ok(/:focus-visible\{outline:2px solid var\(--accent\)/.test(css) && /prefers-reduced-motion:reduce/.test(css), 'P22-T270 ' + C + ': Fokusrahmen und reduced-motion');

console.log('PASS P22-T270 Agententeam-Suche ' + checks + ' checks');
