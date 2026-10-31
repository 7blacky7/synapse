/**
 * P22-T196 (User 31.10.2026 ~14:55): Szene der Uebersicht als globales Agentennetzwerk.
 * Gleiche Typen und Zeichenschleife wie das Projektnetzwerk (Agentennetzwerk.tsx mit Prop global) und dieselbe Sonnen-Logik wie die
 * Visum-Sonnen P22-T229 (sonnen.ts: sonnenSicht/sonnenFade/sonnenFarbe/zielProjekt; Knoten rolle 'sonne' mit Feld sonne, Szene.fremd).
 * - Mitte: Hauptagent. Der Kern ist ein unsichtbarer Anker (Szene.global): kein Projektstern, keine Trabanten, kein Nebel.
 *   P22-T239: die Effekte des Projektkerns (Glut/Puls, Wellen, Trabanten, Nebel, Index-Reaktion, Commit) traegt jede Sonne
 *   (netzwerk/sonnen-effekte.ts, Zeichnung in Agentennetzwerk.tsx); Knoten.umlauf = Abstand ihrer Agentenbahn.
 * - Sonnen: NUR Projekte mit echter Aktivitaet (projekt_aktivitaeten bzw. Zielprojekt der Ereignisse aus ?umfang=global, P22-T232),
 *   unabhaengig vom Projektstatus aktiv/Watcher. Sichtbar bis letzte Aktivitaet + inaktiv_sekunden, danach Ausblenden ueber
 *   fremd_sonne_ausblend_sekunden (bestehende Einstellungen, kein neues Zeitfenster). Das Gedaechtnis haelt eine Sonne bis zum Ende
 *   ihres Ausblendens, auch wenn das Projekt schon aus dem Snapshot gefallen ist.
 * - Agenten haengen an ihrer Heimat-Sonne (heimat_projekt; Visum-Regel P22-T229); die Heimat erscheint mit, solange der Agent aktiv ist.
 *   Impulse laufen zur Sonne des Projekts, in dem der Aufruf wirkt (baue() in Agentennetzwerk.tsx ueber g.fremd und zielProjekt).
 * - Projektlose Aufrufe (ziel_projekt null, Abnahme 35d1ce22) bilden keine Sonne; ihr Ziel ist der Hauptagent (Szene.mitte).
 * - Positionen nur aus Namen und Gruppengroessen (deterministisch, Reihenfolge nach Namen, kein Umsortieren je Puls).
 */
import type { NetzAgent, NetzEreignis, NetzSnapshot } from '../../api/agentennetzwerk';
import { agentAvatar, agentFarbe, keinAgent, type Knoten, type Szene } from './nerven-szene';
import { heimatProjekt, sonnenFarbe, sonnenSicht, sonnenWerte, zielProjekt, type FremdSonne, type SonnenGedaechtnis } from './sonnen';
import { planFade, planFarbe, planZustand } from './plan-nachleuchten';

/** Projekt des Hauptagenten: keine eigene Sonne, der Hauptagent steht in der Mitte. */
export const HAUPTAGENT_PROJEKT = 'synapse-hauptagent';
const TAU = Math.PI * 2, GOLDWINKEL = 2.399963229728653;
const polar = (r: number, w: number) => ({ x: Math.cos(w) * r, y: Math.sin(w) * r });
/** P22-T155: ohne Absender nie ein Knoten. */
const OHNE_ABSENDER = new Set(['', 'cloud', 'stdio', 'unbekannt']);
type ProjektAktivitaet = { project: string; letzte_aktivitaet: string | null; aufrufe: number };

export function globaleSzene(s: NetzSnapshot, jetzt: number, gedaechtnis: SonnenGedaechtnis = new Map()): Szene {
 const w = sonnenWerte(s.werte), fenster = s.werte.aktivitaet_sekunden * 1000, schwelle = s.werte.inaktiv_sekunden * 1000;
 const ereignisse = [...new Map([...s.ereignisse, ...(s.channel_ereignisse ?? [])].map(e => [e.id, e])).values()];
 // Agenten: Vertrag (agenten mit Heimat) plus Absender aus den Ereignissen (wie netzwerkSzene); user/system und ohne Absender nie.
 const agenten = new Map(s.agenten.map(a => [a.id, a])), namen = new Map<string, string>();
 for (const a of s.agenten) { namen.set(a.agent, a.id); namen.set(a.name, a.id); }
 const letzte = new Map<string, number>(), raten = new Map<string, number>(), heimat = new Map<string, string>(), letzterAufruf = new Map<string, NetzEreignis>();
 for (const e of ereignisse) {
  if (!e.identity_id && (keinAgent(e.agent) || OHNE_ABSENDER.has(e.agent ?? ''))) continue;
  const id = e.identity_id || namen.get(e.agent) || e.agent, t = Date.parse(e.zeit);
  if (!id || !Number.isFinite(t)) continue;
  if (t >= (letzte.get(id) ?? 0)) { letzte.set(id, t); letzterAufruf.set(id, e); }
  if (jetzt - t <= fenster) raten.set(id, (raten.get(id) ?? 0) + 1);
  const h = heimatProjekt(e); if (h) heimat.set(id, h);
  if (!agenten.has(id)) agenten.set(id, { id, agent: e.agent, name: e.agent, rolle: 'arbeitsagent', project: h || zielProjekt(e), identity_id: e.identity_id, zuletzt_aktiv: e.zeit, kanaele: [] });
 }
 const zuletzt = (a: NetzAgent) => Math.max(letzte.get(a.id) ?? 0, Date.parse(a.zuletzt_aktiv || '') || 0);
 const heimatVon = (a: NetzAgent) => heimat.get(a.id) || (a as NetzAgent & { heimat_projekt?: string | null }).heimat_projekt || a.project || '';
 // Hauptagent: rolle main (Projekt-Snapshot) bzw. Heimat synapse-hauptagent (globaler Umfang); alle seine Laeufe sind EIN Knoten.
 const alle = [...agenten.values()], istMain = (a: NetzAgent) => a.rolle === 'main' || heimatVon(a) === HAUPTAGENT_PROJEKT;
 const mains = alle.filter(istMain), main = mains.find(a => a.rolle === 'main') ?? mains[0];
 const aktiv = alle.filter(a => !istMain(a) && jetzt - zuletzt(a) <= schwelle)
  .sort((a, b) => Number(b.rolle === 'koordinator') - Number(a.rolle === 'koordinator') || a.id.localeCompare(b.id));

 // Projektaktivitaet: Serverliste (T232, ganzes Fenster, nicht durch ereignis_limit gekappt), Zielprojekte der Ereignisse,
 // dazu die Heimaten aktiver Agenten (Visum-Regel: der Agent bringt seine Heimat-Sonne mit).
 const roh = new Map<string, { letzte: number; aufrufe: number; agenten: Set<string> }>();
 const eintrag = (p: string) => { let z = roh.get(p); if (!z) { z = { letzte: 0, aufrufe: 0, agenten: new Set() }; roh.set(p, z); } return z; };
 const liste = (s as NetzSnapshot & { projekt_aktivitaeten?: ProjektAktivitaet[] }).projekt_aktivitaeten, ausListe = Array.isArray(liste);
 for (const p of ausListe ? liste! : []) if (p?.project) { const z = eintrag(p.project); z.letzte = Math.max(z.letzte, Date.parse(p.letzte_aktivitaet ?? '') || 0); z.aufrufe = Math.max(z.aufrufe, Number(p.aufrufe) || 0); }
 for (const e of ereignisse) { const p = zielProjekt(e), t = Date.parse(e.zeit); if (!p || !Number.isFinite(t)) continue; const z = eintrag(p); z.letzte = Math.max(z.letzte, t); if (!ausListe) z.aufrufe++; }
 for (const a of aktiv) { const h = heimatVon(a); if (h) { const z = eintrag(h); z.letzte = Math.max(z.letzte, zuletzt(a)); z.agenten.add(a.agent); } }
 roh.delete(HAUPTAGENT_PROJEKT); roh.delete('');
 // Gedaechtnis (gleiche Form wie bei den Visum-Sonnen): neue Daten uebernehmen, nicht mehr gelieferte Projekte blenden aus.
 for (const [p, z] of roh) {
  const alt = gedaechtnis.get(p);
  if (alt) { alt.letzte = Math.max(alt.letzte, z.letzte); alt.aufrufe = z.aufrufe; alt.agenten = z.agenten; }
  else gedaechtnis.set(p, { letzte: z.letzte, zugangBis: null, zugang: null, agenten: z.agenten, aufrufe: z.aufrufe, heimatAufrufe: 0 });
 }
 for (const [p, z] of gedaechtnis) if (!roh.has(p)) { z.aufrufe = 0; z.agenten = new Set(); }
 const sonnen: FremdSonne[] = [];
 for (const [p, z] of [...gedaechtnis].sort(([a], [b]) => a.localeCompare(b))) {
  const sicht = sonnenSicht(z.letzte, null, jetzt, w);
  if (sicht.fade <= 0) { gedaechtnis.delete(p); continue; }
  sonnen.push({ projekt: p, agenten: [...z.agenten].sort(), letzte: z.letzte, zugangBis: null, zugang: null, ...sicht, ausblendMs: w.ausblendMs, aufrufe: z.aufrufe, heimatAufrufe: 0 });
 }

 // Agenten je Sonne: Heimat, sonst Zielprojekt des letzten Aufrufs; ohne sichtbare Sonne nahe der Mitte.
 const sichtbar = new Set(sonnen.map(f => f.projekt)), gruppen = new Map<string, NetzAgent[]>(), frei: NetzAgent[] = [];
 for (const a of aktiv) {
  const h = heimatVon(a), la = letzterAufruf.get(a.id), z = la ? zielProjekt(la) : '';
  const p = sichtbar.has(h) ? h : sichtbar.has(z) ? z : '';
  if (p) { const l = gruppen.get(p) ?? []; l.push(a); gruppen.set(p, l); } else frei.push(a);
 }
 const n = sonnen.length, jeSonne = Math.max(3, Math.floor((s.werte.sichtbare_agenten - 1) / Math.max(1, n)));
 const bahn = (m: number) => 64 + 9 * Math.sqrt(Math.max(1, m));
 const groesste = Math.min(jeSonne + 1, Math.max(0, ...[...gruppen.values()].map(l => l.length)));
 // Abstand zweier Sonnen = zwei Agentenbahnen plus Luft. Bis 8 Sonnen ein Ring um den Hauptagenten, darueber eine Spirale (Goldwinkel).
 const D = 2 * (bahn(groesste) + 40) + 40;
 const lageVon = (i: number) => n <= 8 ? polar(Math.max(240, n * D / TAU), -Math.PI / 2 + i * TAU / n) : polar(D * 0.62 * Math.sqrt(i + 1.6), -Math.PI / 2 + i * GOLDWINKEL);

 const knoten: Knoten[] = [], alias = new Map<string, Knoten>(), kanten: Array<[Knoten, Knoten]> = [];
 const merke = (k: Knoten, ids: Array<string | null | undefined>) => { for (const id of ids) if (id) alias.set(id, k); return k; };
 const kern = merke({ id: 'global', name: 'Synapse', rolle: 'zentrum', project: '', x: 0, y: 0, radius: 0, winkel: 0, farbe: '#F97316', letzte: 0, aufrufe: 0, avatar: 'S' }, ['global']);
 knoten.push(kern);
 const ausAgent = (a: NetzAgent, x: number, y: number, radius: number, winkel: number): Knoten => merke({
  id: a.id, name: a.name, rolle: a.rolle === 'koordinator' ? 'koordinator' : 'arbeitsagent', project: heimatVon(a), x, y, radius, winkel,
  farbe: agentFarbe(a), letzte: zuletzt(a), aufrufe: a.aufrufe_im_fenster ?? raten.get(a.id) ?? 0,
  avatar: agentAvatar(a.name), agent: a, letzterAufruf: letzterAufruf.get(a.id),
 }, [a.id, a.agent, a.name, a.identity_id]);
 let mitte: Knoten | undefined;
 if (main) {
  const m = merke({ id: main.id, name: 'Hauptagent', rolle: 'main', project: HAUPTAGENT_PROJEKT, x: 0, y: 0, radius: 17, winkel: -Math.PI / 2, farbe: '#F97316',
   letzte: Math.max(...mains.map(zuletzt)), aufrufe: mains.reduce((z, a) => z + (a.aufrufe_im_fenster ?? raten.get(a.id) ?? 0), 0), avatar: 'HA', agent: main, letzterAufruf: letzterAufruf.get(main.id),
  }, mains.flatMap(a => [a.id, a.agent, a.name, a.identity_id]));
  m.eltern = kern; knoten.push(m); mitte = m;
 }
 let aussen = 240, verborgen = 0;
 sonnen.forEach((f, i) => {
  const ort = lageVon(i), wk = Math.atan2(ort.y, ort.x);
  const sonne = merke({ id: 'projekt:' + f.projekt, name: f.projekt, rolle: 'sonne', project: f.projekt, x: ort.x, y: ort.y, radius: 22, winkel: wk, farbe: sonnenFarbe(f.projekt),
   letzte: f.letzte, aufrufe: f.aufrufe, avatar: agentAvatar(f.projekt), sonne: f, fade: f.fade,
   info: f.aufrufe + ' Aufrufe im Fenster · ' + f.agenten.length + (f.agenten.length === 1 ? ' aktiver Agent' : ' aktive Agenten') }, ['projekt:' + f.projekt, 'workspace:' + f.projekt]);
  knoten.push(sonne); kanten.push([kern, sonne]);
  const liste2 = gruppen.get(f.projekt) ?? [], zeigen = liste2.slice(0, jeSonne), rest = liste2.slice(jeSonne);
  const plaetze = Math.max(1, zeigen.length + (rest.length ? 1 : 0)), ro = bahn(plaetze);
  // P22-T239: Abstand der Agentenbahn; Trabanten, Nebel und Wellen der Sonne richten sich danach.
  sonne.umlauf = ro;
  zeigen.forEach((a, j) => {
   // Erster Agent zeigt nach aussen (weg vom Hauptagenten), Koordinatoren auf einer inneren Bahn.
   const wj = wk + j * TAU / plaetze, koord = a.rolle === 'koordinator', p = polar(koord ? ro * 0.8 : ro, wj);
   const k = ausAgent(a, ort.x + p.x, ort.y + p.y, koord ? 17 : 8, wj); k.eltern = sonne; knoten.push(k); kanten.push([sonne, k]);
   k.zuordnung = 'Heimat ' + f.projekt + (heimat.has(a.id) ? ' · heimat_projekt (P22-T232)' : ' · Projekt des Agenten');
  });
  if (rest.length) {
   const wj = wk + zeigen.length * TAU / plaetze, p = polar(ro + 26, wj);
   const cluster: Knoten = { id: 'cluster:' + f.projekt, name: 'Weitere aktive Agenten', rolle: 'cluster', project: f.projekt, x: ort.x + p.x, y: ort.y + p.y, radius: 26, winkel: wj,
    letzte: jetzt, count: rest.length, avatar: String(rest.length), farbe: '#fdba74', eltern: sonne,
    aufrufe: rest.reduce((z, a) => z + (a.aufrufe_im_fenster ?? raten.get(a.id) ?? 0), 0), info: rest.length + ' aktive Agenten · gruppiert' };
   knoten.push(cluster); kanten.push([sonne, cluster]); alias.set(cluster.id, cluster); verborgen += rest.length;
   for (const a of rest) for (const id of [a.id, a.agent, a.name, a.identity_id]) if (id) alias.set(id, cluster);
  }
  aussen = Math.max(aussen, Math.hypot(ort.x, ort.y) + ro + 70);
 });
 // P22-T239: offene Schattenplaene je Projekt als goldene Rauten an ihrer Sonne (zwischen Sonne und Beitragenden, wie im Arbeitsraum
 // zwischen Kern und Agenten). Beendete Plaene sind kein Knoten, sondern ein Abgang (Commit-Flug in die Sonne bzw. Explosion).
 const planVonAgent = new Map<string, string>(), planJeSonne = new Map<string, number>();
 let planZahl = 0;
 for (const p of (s.plaene ?? []).filter(x => x.status === 'open' && x.project)) {
  const sonne = alias.get('projekt:' + p.project); if (!sonne || sonne.rolle !== 'sonne') continue;
  const teilnehmer = [...new Set((p.beitraege ?? []).map(id => alias.get(id)?.id).filter((id): id is string => !!id && id !== sonne.id && id !== kern.id))];
  const nah = teilnehmer.map(id => alias.get(id)!).filter(k => k.eltern === sonne), i = planJeSonne.get(sonne.id) ?? 0; planJeSonne.set(sonne.id, i + 1);
  const basis = nah.length ? Math.atan2(nah.reduce((n, k) => n + k.y - sonne.y, 0), nah.reduce((n, k) => n + k.x - sonne.x, 0)) : sonne.winkel + Math.PI;
  const wk = basis + (i % 2 ? -1 : 1) * Math.ceil(i / 2) * 0.55, ort = polar((sonne.umlauf ?? 80) * 0.55, wk), co = teilnehmer.length > 1;
  const k: Knoten = { id: 'plan:' + p.id, name: 'Plan ' + p.id, rolle: 'plan', project: p.project ?? '', x: sonne.x + ort.x, y: sonne.y + ort.y, radius: 13, winkel: wk, avatar: 'P', farbe: planFarbe(p),
   letzte: Date.parse(p.committed ?? p.erstellt), aufrufe: p.ops, teilnehmer, plan: p, eltern: sonne, fade: planFade(p, jetzt, s),
   info: p.ops + ' Ops · ' + p.dateien + ' Dateien' + (co ? ' · Co-Edit ' + teilnehmer.length : '') + ' · ' + planZustand(p) };
  knoten.push(k); alias.set(k.id, k); kanten.push([sonne, k]); planZahl++;
  for (const id of teilnehmer) { const alt = planVonAgent.get(id); if (!alt || Number(alt) < Number(p.id)) planVonAgent.set(id, p.id); }
 }
 // Aktive Agenten ohne sichtbare Sonne (Heimat unbekannt bzw. nur Hauptagent-Projekt): kleiner Ring um die Mitte.
 const freiZeigen = frei.slice(0, jeSonne);
 freiZeigen.forEach((a, j) => {
  const wj = -Math.PI / 2 + (j + 0.5) * TAU / freiZeigen.length, p = polar(92 + (j % 2) * 18, wj), k = ausAgent(a, p.x, p.y, 8, wj);
  // P22-T244: Bahn zum Hauptagenten (sichtbar), nicht zum unsichtbaren Anker; ohne Hauptagent keine Bahn (Renderer zeichnet nichts vom Anker).
  k.eltern = kern; k.zuordnung = 'ohne Projektsonne (Heimat unbekannt oder ohne Aktivität)'; knoten.push(k); kanten.push([mitte ?? kern, k]);
 });
 verborgen += frei.length - freiZeigen.length;
 const radius = Math.max(280, aussen);
 return { knoten, alias, kanten, projekte: [], kern, radius, breite: radius * 2, hoehe: radius * 2, verborgen,
  inaktiv: Math.max(0, alle.length - aktiv.length - mains.length), channels: 0, zelle: 34, planVonAgent, plaene: planZahl, stern: 0.5,
  fremd: sonnen, fremdOhneSonne: 0, global: true, mitte };
}
