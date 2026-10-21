/**
 * P22-T93 Darstellung "Nervensystem": deterministisches Layout aus dem API-Vertrag /agentennetzwerk.
 * Kern = Projekt (P22-T95), innerer Ring = Hauptagent und Koordinatoren, dazwischen Schattenplaene, aeussere Zellen = Arbeitsagenten.
 * Positionen haengen nur von IDs und Gruppengroessen ab, nie von Zufall; Zuordnung nur aus API-Belegen.
 */
import type { NetzAgent, NetzEreignis, NetzPlan, NetzSnapshot } from '../../api/agentennetzwerk';

export type Rgb = [number, number, number];
/** form: 0 Glut, 1 Ring, 2 Raute, 3 Quadrat, 4 Funke, 5 Sechseck, 6 Dreieck, 7 Zelle, 8 Stern, 9 Kern */
export interface WerkzeugStil { icon: string; farbe: string; name: string; form: number }
export const STILE: Record<string, WerkzeugStil> = {
 chat: { icon: '↗', farbe: '#38bdf8', name: 'Chat', form: 4 }, channel: { icon: '#', farbe: '#a78bfa', name: 'Channel', form: 5 },
 shell: { icon: '>_', farbe: '#4ade80', name: 'Shell', form: 3 }, plan: { icon: '☷', farbe: '#fbbf24', name: 'Plan', form: 2 },
 files: { icon: '▱', farbe: '#fb923c', name: 'Dateien', form: 6 }, code_intel: { icon: '⌘', farbe: '#22d3ee', name: 'Code', form: 1 },
 memory: { icon: '◇', farbe: '#f472b6', name: 'Wissen', form: 2 }, thought: { icon: '✦', farbe: '#e879f9', name: 'Thought', form: 4 },
 docs: { icon: '▤', farbe: '#67e8f9', name: 'Doku', form: 3 }, event: { icon: 'ϟ', farbe: '#fde047', name: 'Events', form: 4 },
 admin: { icon: '◎', farbe: '#fda4af', name: 'Admin', form: 1 }, project: { icon: '⌂', farbe: '#c4b5fd', name: 'Projekt', form: 5 },
 specialist: { icon: '♧', farbe: '#86efac', name: 'Agenten', form: 7 }, skills: { icon: '✧', farbe: '#f0abfc', name: 'Skills', form: 4 },
 hex: { icon: '01', farbe: '#93c5fd', name: 'Hex', form: 3 }, asset_intel: { icon: '▧', farbe: '#fdba74', name: 'Assets', form: 6 },
 jev: { icon: '◈', farbe: '#a5b4fc', name: 'Jev', form: 2 }, tools: { icon: '⚙', farbe: '#F97316', name: 'Tools', form: 0 },
};
export const werkzeugName = (tool: string) => tool.split('__').pop() || tool;
export function stil(tool: string): WerkzeugStil {
 const name = werkzeugName(tool);
 return STILE[name] || { ...STILE.tools, icon: name.slice(0, 2).toUpperCase() || '⚙', name };
}
const rgbCache = new Map<string, Rgb>();
export function rgb(hex: string): Rgb {
 let c = rgbCache.get(hex);
 if (!c) {
  const h = hex.replace('#', ''), n = parseInt(h.length === 3 ? h.split('').map(x => x + x).join('') : h.slice(0, 6), 16);
  c = [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  rgbCache.set(hex, c);
 }
 return c;
}
export function agentAvatar(name: string) {
 const teile = name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/);
 return (teile.length > 1 ? teile[0][0] + teile.at(-1)![0] : name.slice(0, 2) || '?').toUpperCase();
}
/** Modellfamilie bestimmt die Lichtfarbe einer Zelle (aus agenten-team, sonst neutral). */
export function agentFarbe(a: NetzAgent) {
 const typ = (a.typ || '') + ' ' + (a.modell || '');
 return /claude|anthropic/i.test(typ) ? '#ffb98a' : /codex|gpt|openai/i.test(typ) ? '#6ee7d0' : /spezialist|specialist/i.test(typ) ? '#b9adff' : '#a9bfd6';
}

export interface Knoten {
 id: string; name: string; rolle: string; project: string; x: number; y: number; radius: number; winkel: number;
 farbe: string; letzte: number; aufrufe: number; avatar: string;
 agent?: NetzAgent; letzterAufruf?: NetzEreignis; info?: string; count?: number; zuordnung?: string;
 eltern?: Knoten; teilnehmer?: string[];
 /** P22-T95: Schattenplan-Metadaten; fade < 1 = gerade committet, leuchtet aus. */
 plan?: NetzPlan; fade?: number;
}
export interface Konstellation { name: string; x: number; y: number; winkel: number }
export interface Szene {
 knoten: Knoten[]; alias: Map<string, Knoten>; kanten: Array<[Knoten, Knoten]>; projekte: Konstellation[];
 kern: Knoten; radius: number; breite: number; hoehe: number; verborgen: number; inaktiv: number; channels: number;
 /** Zellabstand der Arbeitsagenten in Weltpunkten (dichte Netze = kleiner). */
 zelle: number;
 /** P22-T95: Knoten-ID eines Agenten -> juengster offener Plan, an dem er beitraegt. */
 planVonAgent: Map<string, string>; plaene: number;
}

const PHI = 0.6180339887, TAU = Math.PI * 2;
const frac = (x: number) => x - Math.floor(x);
const polar = (r: number, w: number) => ({ x: Math.cos(w) * r, y: Math.sin(w) * r });
const mittelwinkel = (punkte: Knoten[], ersatz: number) => punkte.length ? Math.atan2(punkte.reduce((n, k) => n + Math.sin(k.winkel), 0), punkte.reduce((n, k) => n + Math.cos(k.winkel), 0)) : ersatz;
/** Schiebt Knoten auf einem Ring auseinander, bis benachbarte Winkel mindestens den Abstand halten. */
function verteile(liste: Array<{ w: number }>, max: number) {
 const abstand = Math.min(max, TAU / Math.max(1, liste.length));
 for (let lauf = 0; lauf < 6; lauf++) for (let i = 0; i < liste.length; i++) {
  const a = liste[i], b = liste[(i + 1) % liste.length]; if (a === b) continue;
  let d = b.w - a.w; if (i === liste.length - 1) d += TAU;
  if (d < abstand) { a.w -= (abstand - d) / 2; b.w += (abstand - d) / 2; }
 }
}

interface Gruppe { project: string; koordinator?: NetzAgent; sichtbar: NetzAgent[]; versteckt: NetzAgent[]; spanne: number; mitte: number }

export function netzwerkSzene(s: NetzSnapshot, jetzt: number): Szene {
 const aktiv = new Map<string, number>(), raten = new Map<string, number>(), letzterAufruf = new Map<string, NetzEreignis>();
 const agenten = new Map(s.agenten.map(a => [a.id, a])), namen = new Map<string, string>();
 for (const a of s.agenten) { namen.set(a.agent, a.id); namen.set(a.name, a.id); }
 const fenster = s.werte.aktivitaet_sekunden * 1000, schwelle = s.werte.inaktiv_sekunden * 1000;
 const alleEreignisse = [...new Map([...s.ereignisse, ...(s.channel_ereignisse ?? [])].map(e => [e.id, e])).values()];
 for (const e of alleEreignisse) {
  const id = e.identity_id || namen.get(e.agent) || e.agent, zeit = Date.parse(e.zeit);
  aktiv.set(id, Math.max(aktiv.get(id) || 0, zeit));
  if (jetzt - zeit <= fenster) raten.set(id, (raten.get(id) || 0) + 1);
  if (!letzterAufruf.has(id) || Date.parse(letzterAufruf.get(id)!.zeit) <= zeit) letzterAufruf.set(id, e);
  if (!agenten.has(id)) agenten.set(id, { id, agent: e.agent, name: e.agent, rolle: 'arbeitsagent', project: e.project, identity_id: e.identity_id, zuletzt_aktiv: e.zeit, kanaele: [] });
 }
 // Empfaenger echter DMs sind beteiligt, auch wenn sie selbst noch nichts aufgerufen haben.
 for (const e of s.ereignisse) if (e.ok && werkzeugName(e.tool) === 'chat' && e.interaktion === 'senden') for (const ziel of e.empfaenger) {
  const id = namen.get(ziel) || ziel; aktiv.set(id, Math.max(aktiv.get(id) || 0, Date.parse(e.zeit)));
  if (!agenten.has(id)) agenten.set(id, { id, agent: ziel, name: ziel, rolle: 'arbeitsagent', project: e.project, identity_id: null, zuletzt_aktiv: e.zeit, kanaele: [] });
 }
 const letzte = (a: NetzAgent) => Math.max(aktiv.get(a.id) || 0, Date.parse(a.zuletzt_aktiv || '') || 0);
 const alle = [...agenten.values()], main = alle.find(a => a.rolle === 'main');
 const koord = alle.filter(a => a.rolle === 'koordinator').sort((a, b) => a.id.localeCompare(b.id));
 const arbeiter = alle.filter(a => !['main', 'koordinator'].includes(a.rolle) && jetzt - letzte(a) <= schwelle)
  .sort((a, b) => letzte(b) - letzte(a) || a.id.localeCompare(b.id));
 const ausgewaehlt = new Set(arbeiter.slice(0, Math.max(0, s.werte.sichtbare_agenten - 1 - koord.length)).map(a => a.id));

 const knoten: Knoten[] = [], alias = new Map<string, Knoten>(), kanten: Array<[Knoten, Knoten]> = [];
 const merke = (k: Knoten, ids: string[]) => { for (const id of ids) alias.set(id, k); return k; };
 const ausAgent = (a: NetzAgent, x: number, y: number, radius: number, winkel: number): Knoten => merke({
  id: a.id, name: a.name, rolle: a.rolle, project: a.project, x, y, radius, winkel,
  farbe: a.rolle === 'main' ? '#F97316' : agentFarbe(a), letzte: letzte(a), aufrufe: a.aufrufe_im_fenster ?? raten.get(a.id) ?? 0,
  avatar: agentAvatar(a.name), agent: a, letzterAufruf: letzterAufruf.get(a.id),
 }, [a.id, a.agent, a.name]);
 // P22-T95: das Projekt ist der Kern; der Hauptagent ist ein normaler Knoten auf dem inneren Ring.
 const kern = merke({ id: 'projekt:' + s.project, name: s.project, rolle: 'zentrum', project: s.project, x: 0, y: 0, radius: 34, winkel: 0, farbe: '#F97316', letzte: 0, aufrufe: 0, avatar: agentAvatar(s.project) }, ['projekt:' + s.project, 'workspace:' + s.project]);
 knoten.push(kern);

 // Gruppen: je Koordinator eine, dazu die Projektgruppe fuer Agenten ohne Start-/Kommunikationsbeleg.
 const projekte = [...new Set([s.project, ...koord.map(a => a.project), ...arbeiter.map(a => a.project)])].sort();
 const gruppen: Gruppe[] = [];
 if (main) gruppen.push({ project: s.project, koordinator: main, sichtbar: [], versteckt: [], spanne: 0, mitte: 0 });
 for (const project of projekte) {
  const kp = koord.filter(a => a.project === project), wp = arbeiter.filter(a => a.project === project);
  const belegt = (a: NetzAgent) => kp.find(k => k.id === a.koordination?.koordinator_id);
  for (const k of kp) {
   const w = wp.filter(a => belegt(a)?.id === k.id).sort((a, b) => a.id.localeCompare(b.id));
   gruppen.push({ project, koordinator: k, sichtbar: w.filter(a => ausgewaehlt.has(a.id)), versteckt: w.filter(a => !ausgewaehlt.has(a.id)), spanne: 0, mitte: 0 });
  }
  const frei = wp.filter(a => !belegt(a)).sort((a, b) => a.id.localeCompare(b.id));
  if (frei.length || !kp.length) gruppen.push({ project, sichtbar: frei.filter(a => ausgewaehlt.has(a.id)), versteckt: frei.filter(a => !ausgewaehlt.has(a.id)), spanne: 0, mitte: 0 });
 }
 const RK = Math.min(300, 175 + koord.length * 8), R0 = RK + 96;
 // Wenige Zellen bekommen viel Luft, viele ruecken zu einer dichten Konstellation zusammen.
 const zahl = gruppen.reduce((n, g) => n + g.sichtbar.length, 0), ZELLE = zahl <= 40 ? 46 : zahl <= 150 ? 34 : 25;
 // Winkelbedarf je Gruppe; Rest verteilt sich auf Sektoren und Luft, damit wenige Gruppen symmetrisch um den Kern stehen.
 const bedarf = gruppen.map(g => Math.max(0.6, Math.sqrt(g.sichtbar.length + (g.versteckt.length ? 2 : 0)) * ZELLE * 1.7 / R0));
 const luft = gruppen.map((g, i) => i && gruppen[i - 1].project !== g.project ? 0.4 : 0.14);
 const summe = bedarf.reduce((n, b) => n + b, 0) + luft.reduce((n, l) => n + l, 0);
 const faktor = summe > TAU ? (TAU - luft.reduce((n, l) => n + l, 0)) / bedarf.reduce((n, b) => n + b, 0) : 1;
 const rest = summe < TAU ? TAU - summe : 0, dehnung = 1 + rest * 0.6 / Math.max(0.01, bedarf.reduce((n, b) => n + b, 0));
 const extra = rest * 0.4 / Math.max(1, gruppen.length);
 let winkel = -Math.PI / 2 - (bedarf[0] ?? 0) * faktor / 2;
 gruppen.forEach((g, i) => {
  winkel += i ? luft[i] + extra : 0;
  g.spanne = bedarf[i] * faktor * Math.min(dehnung, 2.6); g.mitte = winkel + g.spanne / 2; winkel += g.spanne;
 });
 const mehrere = projekte.length > 1, naben = new Map<string, Knoten>(), konstellationen: Konstellation[] = [];
 for (const project of projekte) {
  const eigene = gruppen.filter(g => g.project === project);
  if (project === s.project) { naben.set(project, kern); konstellationen.push({ name: project, winkel: 0, ...polar(R0, 0) }); continue; }
  const w = eigene.length ? Math.atan2(eigene.reduce((n, g) => n + Math.sin(g.mitte), 0), eigene.reduce((n, g) => n + Math.cos(g.mitte), 0)) : 0;
  const p = mehrere ? polar(RK * 0.58, w) : { x: 0, y: 0 };
  const nabe = merke({ id: 'projekt:' + project, name: project, rolle: 'projekt', project, x: p.x, y: p.y, radius: 18, winkel: w, farbe: '#F97316', letzte: 0, aufrufe: 0, avatar: '' }, ['projekt:' + project, 'workspace:' + project]);
  knoten.push(nabe); naben.set(project, nabe);
  konstellationen.push({ name: project, winkel: w, ...polar(R0, w) });
 }
 let verborgen = 0, aussen = R0;
 for (const g of gruppen) {
  const nabe = naben.get(g.project)!;
  let eltern = nabe;
  if (g.koordinator) {
   const p = polar(RK, g.mitte);
   eltern = ausAgent(g.koordinator, p.x, p.y, 17, g.mitte); eltern.eltern = kern;
   knoten.push(eltern); kanten.push([kern, eltern]);
  }
  // Flaechentreue Fuellung des Sektors: r^2 waechst linear, Winkel nach goldenem Schnitt.
  const breite = g.spanne * 0.9, flaeche = 2 * ZELLE * ZELLE / Math.max(0.3, breite);
  g.sichtbar.forEach((a, i) => {
   const r = Math.sqrt(R0 * R0 + i * flaeche), w = g.mitte + (frac(i * PHI + 0.5) - 0.5) * breite, p = polar(r, w);
   const k = ausAgent(a, p.x, p.y, 8, w); k.eltern = eltern; knoten.push(k); kanten.push([eltern, k]);
   k.zuordnung = g.koordinator && a.koordination ? (a.koordination.quelle === 'specialist_jobs.spawn' ? 'Gestartet von ' : 'Kommunikation mit ') + eltern.name + ' · ' + a.koordination.quelle + ' #' + a.koordination.beleg_id : 'Projekt · kein Start-/Kommunikationsbeleg';
   aussen = Math.max(aussen, r);
  });
  if (g.versteckt.length) {
   const r = Math.sqrt(R0 * R0 + g.sichtbar.length * flaeche) + 44, p = polar(r, g.mitte);
   const cluster: Knoten = { id: 'cluster:' + g.project + ':' + (g.koordinator?.id ?? 'projekt'), name: 'Weitere aktive Agenten', rolle: 'cluster', project: g.project, x: p.x, y: p.y, radius: 26, winkel: g.mitte,
    letzte: jetzt, count: g.versteckt.length, avatar: String(g.versteckt.length), farbe: '#fdba74', eltern,
    aufrufe: g.versteckt.reduce((n, a) => n + (a.aufrufe_im_fenster ?? raten.get(a.id) ?? 0), 0), info: g.versteckt.length + ' aktive Agenten · gruppiert' };
   knoten.push(cluster); kanten.push([eltern, cluster]); verborgen += g.versteckt.length; aussen = Math.max(aussen, r + 20);
   alias.set(cluster.id, cluster);
   for (const a of g.versteckt) for (const id of [a.id, a.agent, a.name]) alias.set(id, cluster);
  }
 }
 // Channels sind Synapsen zwischen Kern und Koordinatoren, ausgerichtet auf ihre echten Teilnehmer.
 const kanalNamen = [...new Set(alleEreignisse.filter(e => e.ok && e.channel && jetzt - Date.parse(e.zeit) <= schwelle).map(e => e.channel!))].sort();
 const sichtbar = kanalNamen.slice(0, s.werte.sichtbare_channels), RC = RK * 0.74;
 const kanaele = sichtbar.map((name, i) => {
  const calls = alleEreignisse.filter(e => e.ok && e.channel === name && jetzt - Date.parse(e.zeit) <= schwelle);
  const teilnehmer = [...new Set(calls.map(e => (alias.get(e.identity_id || e.agent) || alias.get(e.agent))?.id).filter((id): id is string => !!id && id !== kern.id))];
  const punkte = teilnehmer.map(id => alias.get(id)!).filter(k => k.rolle !== 'main');
  const w = mittelwinkel(punkte, -Math.PI / 2 + i * TAU / Math.max(1, sichtbar.length));
  return { name, w, calls, teilnehmer };
 }).sort((a, b) => a.w - b.w);
 verteile(kanaele, 0.62);
 for (const c of kanaele) {
  const fenstercalls = c.calls.filter(e => jetzt - Date.parse(e.zeit) <= fenster), schreiber = new Set(fenstercalls.filter(e => e.action === 'post').map(e => e.agent));
  const p = polar(RC, c.w);
  const k: Knoten = { id: 'channel:' + c.name, name: '# ' + c.name, rolle: 'channel', project: s.project, x: p.x, y: p.y, radius: 15, winkel: c.w, avatar: '#', farbe: '#a78bfa',
   letzte: Math.max(0, ...c.calls.map(e => Date.parse(e.zeit))), aufrufe: fenstercalls.length, teilnehmer: c.teilnehmer, letzterAufruf: c.calls.at(-1),
   info: Math.round(fenstercalls.length * 60 / s.werte.aktivitaet_sekunden) + '/min · ' + schreiber.size + ' Schreiber' };
  knoten.push(k); alias.set(k.id, k);
 }
 // P22-T95: offene files-Plaene (Schattenplaene) als Knoten zwischen Projekt und Agenten, ausgerichtet auf ihre Beitragenden.
 const planVonAgent = new Map<string, string>();
 // Beendete Plaene zeigt die Grafik nicht als Knoten, sondern als Abgang (Einfliessen bzw. Explosion).
 const plaene = (s.plaene ?? []).filter(p => p.status === 'open').slice(0, 16);
 const planItems = plaene.map((p, i) => {
  const teilnehmer = [...new Set(p.beitraege.map(id => alias.get(id)?.id).filter((id): id is string => !!id && id !== kern.id))];
  return { w: mittelwinkel(teilnehmer.map(id => alias.get(id)!), Math.PI / 2 + i * TAU / Math.max(1, plaene.length)), plan: p, teilnehmer };
 }).sort((a, b) => a.w - b.w);
 verteile(planItems, 0.5);
 for (const it of planItems) {
  const p = polar(RK * 0.54, it.w), offen = it.plan.status === 'open', co = it.teilnehmer.length > 1;
  const k: Knoten = { id: 'plan:' + it.plan.id, name: 'Plan ' + it.plan.id, rolle: 'plan', project: s.project, x: p.x, y: p.y, radius: 13, winkel: it.w, avatar: 'P', farbe: '#fcd34d',
   letzte: Date.parse(it.plan.committed ?? it.plan.erstellt), aufrufe: it.plan.ops, teilnehmer: it.teilnehmer, plan: it.plan, eltern: kern,
   fade: offen ? 1 : Math.max(0, 1 - (jetzt - Date.parse(it.plan.committed ?? '')) / 30000),
   info: it.plan.ops + ' Ops · ' + it.plan.dateien + ' Dateien' + (co ? ' · Co-Edit ' + it.teilnehmer.length : '') + (offen ? '' : ' · committet') };
  knoten.push(k); alias.set(k.id, k); kanten.push([kern, k]);
  if (offen) for (const id of it.teilnehmer) { const alt = planVonAgent.get(id); if (!alt || Number(alt) < Number(it.plan.id)) planVonAgent.set(id, it.plan.id); }
 }
 if (kanalNamen.length > sichtbar.length) {
  const k: Knoten = { id: 'channels', name: 'Weitere aktive Channels', rolle: 'channel-cluster', project: s.project, x: 0, y: RC * 0.45, radius: 14, winkel: Math.PI / 2, letzte: jetzt, avatar: '+' + (kanalNamen.length - sichtbar.length), farbe: '#a78bfa', aufrufe: 0, count: kanalNamen.length - sichtbar.length };
  knoten.push(k); for (const name of kanalNamen.slice(sichtbar.length)) alias.set('channel:' + name, k);
 }
 const radius = Math.max(R0 + 60, aussen + 56);
 return { knoten, alias, kanten, projekte: mehrere ? konstellationen.map(k => ({ ...k, ...polar(radius - 18, k.winkel) })) : [], kern, radius, breite: radius * 2, hoehe: radius * 2,
  verborgen, inaktiv: alle.length - (main ? 1 : 0) - koord.length - arbeiter.length, channels: kanalNamen.length, zelle: ZELLE, planVonAgent, plaene: planItems.length };
}

export interface Punkt { x: number; y: number }
/** Quadratische Kurve mit seitlicher Woelbung; Vorzeichen deterministisch aus der Lage. */
export function kurve(a: Punkt, b: Punkt, woelbung: number, schritte: number, ziel: number[] = []) {
 const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y;
 const cx = mx - dy * woelbung, cy = my + dx * woelbung;
 for (let i = 0; i <= schritte; i++) {
  const t = i / schritte, u = 1 - t;
  ziel.push(u * u * a.x + 2 * u * t * cx + t * t * b.x, u * u * a.y + 2 * u * t * cy + t * t * b.y);
 }
 return ziel;
}
/** Bogenlaengen-gleichmaessige Abtastung, damit Impulse mit konstanter Geschwindigkeit laufen. */
export function gleichmaessig(punkte: number[], anzahl: number) {
 const n = punkte.length / 2, laengen = [0];
 for (let i = 1; i < n; i++) laengen.push(laengen[i - 1] + Math.hypot(punkte[i * 2] - punkte[i * 2 - 2], punkte[i * 2 + 1] - punkte[i * 2 - 1]));
 const gesamt = laengen[n - 1] || 1, out = new Float32Array(anzahl * 2);
 for (let j = 0, i = 1; j < anzahl; j++) {
  const ziel = gesamt * j / (anzahl - 1);
  while (i < n - 1 && laengen[i] < ziel) i++;
  const t = (ziel - laengen[i - 1]) / ((laengen[i] - laengen[i - 1]) || 1);
  out[j * 2] = punkte[i * 2 - 2] + (punkte[i * 2] - punkte[i * 2 - 2]) * t;
  out[j * 2 + 1] = punkte[i * 2 - 1] + (punkte[i * 2 + 1] - punkte[i * 2 - 1]) * t;
 }
 return { pfad: out, laenge: gesamt };
}
