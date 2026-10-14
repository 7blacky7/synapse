/**
 * P15-T31 (11.10.2026) — Folgen aus P15-T27 (thought c327013d, Commit e374337).
 *
 *  N1 commit auf einen leeren Traeger, dessen Wait auf eine LEBENDE fremde Reservierung wartet:
 *     KEIN success, error nothing_written, grund 'wartet', Plan bleibt offen, Wait bleibt offen.
 *  N2 derselbe Traeger nach Ablauf der fremden Reservierung: grund 'abgelaufen', die Antwort
 *     liefert die Ops zum Neu-Planen (ops_zum_neu_planen) und sagt, was zu tun ist.
 *  N3 Plan ohne Op und ohne Wait: grund 'leer', Hinweis auf cancel. Nichts wird committed.
 *  N4 nichtsGeschriebenBefund fuer auto_commit (Routen nutzen ihn): mehrere Traeger, Grund
 *     'abgelaufen' gewinnt vor 'wartet'.
 *  N5 Kontrolle: ein normaler Plan mit Op committet weiter mit success.
 *  W1 intern waits_tot Vorschau (ausfuehren fehlt): toter Wait mit Besitzer, Ziel-Datei, Alter,
 *     vollen Ops und Basis-Hash; es aendert sich NICHTS (Wait offen, kein thought, kein Event).
 *  W2 lebender Wait wird nicht gelistet.
 *  W3 ausfuehren:true: thought je Wait (tags wait-sicherung + Besitzer, voller Op-Inhalt,
 *     Basis-Hash, Anleitung files(plan)), Event an den Besitzer, DANACH Wait closed und leerer
 *     Traeger cancelled.
 *  W4 Sicherung laesst sich wieder einspielen: Ops aus dem thought -> planBatch + commit schreibt.
 *  W5 ueber fuehreInternAus erreichbar (Action registriert).
 *
 * AUFRUF (Test-DB!): (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/file-batch-nichts-geschrieben.test.mjs
 * Gegenprobe alter Stand: PLAENE_TEST_DIST=<altes dist> node ...
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('file-batch-nichts-geschrieben.test');
const PROJECT = 'nichts-geschrieben-test';
const F = 'ng-fremd';
const W = 'ng-warte';
// W5: intern-tool liest den Schalter beim Laden des Moduls.
process.env.SYNAPSE_INTERN_TOOL = '1';
const batch = await import(join(dist, 'services', 'file-batch.js'));
const res = await import(join(dist, 'services', 'file-reservations.js'));
const { getPool } = await import(join(dist, 'db', 'client.js'));
const waitsMod = await import(join(dist, 'services', 'intern-waits.js')).catch(() => null);
const internMod = await import(join(dist, 'services', 'intern-tool.js')).catch(() => null);
const pool = getPool();

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 700) : '')); }
}
const versuch = async (fn) => { try { return await fn(); } catch (e) { return { success: false, error: e?.message ?? String(e), geworfen: true }; } };
async function aufraeumen() {
  await pool.query(`DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project = $1)`, [PROJECT]);
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events', 'tool_calls', 'thoughts']) {
    await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]);
  }
}
const inhalt = async (p) => (await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL', [PROJECT, p])).rows[0]?.content ?? null;
async function anlegen(p, t) {
  const x = await batch.planBatch({ project: PROJECT, agent_id: 'ng-setup', ops: [{ file_path: p, action: 'create', content: t }] });
  const c = await batch.commitBatch({ plan_id: x.plan_id, agent_id: 'ng-setup' });
  if (!c.success) throw new Error('anlegen ' + p + ': ' + JSON.stringify(c));
}
const sr = (f, search, replace) => ({ file_path: f, action: 'search_replace', search, replace });
const planZeile = async (id) => (await pool.query('SELECT status::text AS status, jsonb_array_length(ops)::int AS ops FROM file_batch_plans WHERE id = $1', [id])).rows[0] ?? null;
const waitStatus = async (token) => (await pool.query('SELECT status FROM file_batch_waits WHERE wait_token = $1::uuid', [token])).rows[0]?.status ?? null;
async function reservierungAblaufen(agent, pfad, sekundenAbJetzt) {
  await pool.query(
    `UPDATE file_reservations SET expires_at = NOW() + ($3 * INTERVAL '1 second')
      WHERE project = $1 AND agent_id = $2 AND file_path = $4 AND released_at IS NULL`,
    [PROJECT, agent, sekundenAbJetzt, pfad],
  );
  await pool.query(
    `UPDATE file_batch_waits SET expires_at = NOW() + ($3 * INTERVAL '1 second')
      WHERE project = $1 AND primary_agent = $2 AND $4 = ANY(shared_files) AND status IN ('waiting', 'linked')`,
    [PROJECT, agent, sekundenAbJetzt, pfad],
  );
}
/** Liest den einspielbaren Ops-Block aus einem Sicherungs-thought. */
function opsAusSicherung(text) {
  const m = /<<<OPS_JSON\n([\s\S]*?)\nOPS_JSON>>>/.exec(text ?? '');
  return m ? JSON.parse(m[1]) : null;
}

try {
  await aufraeumen();

  // ===== N1 leerer Traeger, Wait lebt =====
  await anlegen('src/n1.ts', 'n1-alt\n');
  await res.addFileReservations({ project: PROJECT, agentId: F, filePaths: ['src/n1.ts'] });
  const n1p = await batch.planBatch({ project: PROJECT, agent_id: W, ops: [sr('src/n1.ts', 'n1-alt', 'n1-NEU')] });
  const traeger1 = n1p.plan_id;
  const token1 = n1p.coedit_waits?.[0]?.wait_token;
  pruefe(n1p.total_ops === 0 && typeof token1 === 'string', 'N1: Vorbedingung leerer Traeger mit Wait', n1p);
  const n1 = await versuch(() => batch.commitBatch({ plan_id: traeger1, agent_id: W }));
  pruefe(n1.success === false && n1.error === 'nothing_written' && n1.nichts_geschrieben === true && n1.grund === 'wartet',
    'N1: commit auf leeren Traeger meldet KEIN success, sondern nothing_written mit grund wartet', n1);
  pruefe(typeof n1.was_tun === 'string' && /wait_seconds/.test(n1.was_tun) && /cancel|verwerfen/i.test(n1.was_tun),
    'N1: Antwort sagt, was zu tun ist (warten per Long-Poll, nicht verwerfen)', n1.was_tun);
  pruefe((await planZeile(traeger1))?.status === 'open' && (await waitStatus(token1)) === 'waiting' && (await inhalt('src/n1.ts')) === 'n1-alt\n',
    'N1: Traeger bleibt offen, Wait bleibt offen, Datei unveraendert', { plan: await planZeile(traeger1), wait: await waitStatus(token1) });

  // ===== N2 derselbe Traeger nach Ablauf =====
  await reservierungAblaufen(F, 'src/n1.ts', -60);
  const n2 = await versuch(() => batch.commitBatch({ plan_id: traeger1, agent_id: W }));
  pruefe(n2.success === false && n2.error === 'nothing_written' && n2.grund === 'abgelaufen',
    'N2: nach Ablauf der fremden Reservierung grund abgelaufen', n2);
  pruefe(Array.isArray(n2.ops_zum_neu_planen) && n2.ops_zum_neu_planen.length === 1 && n2.ops_zum_neu_planen[0].replace === 'n1-NEU'
    && /files\(action:"plan"/.test(n2.was_tun ?? ''),
    'N2: Antwort liefert die Ops zum Neu-Planen und den Aufruf', { ops: n2.ops_zum_neu_planen, was_tun: n2.was_tun });
  pruefe((await planZeile(traeger1))?.status === 'open', 'N2: Traeger bleibt offen (nichts geht verloren)', await planZeile(traeger1));

  // ===== N3 Plan ohne Op und ohne Wait =====
  const leer = (await pool.query(
    `INSERT INTO file_batch_plans (project, owner_agent_id, ops, expected_hashes, previews) VALUES ($1, $2, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb) RETURNING id::text AS id`,
    [PROJECT, W],
  )).rows[0].id;
  const n3 = await versuch(() => batch.commitBatch({ plan_id: leer, agent_id: W }));
  pruefe(n3.success === false && n3.error === 'nothing_written' && n3.grund === 'leer' && /cancel/.test(n3.was_tun ?? ''),
    'N3: leerer Plan ohne Wait: nothing_written, grund leer, Hinweis cancel', n3);
  pruefe((await planZeile(leer))?.status === 'open', 'N3: leerer Plan wird nicht als committed markiert', await planZeile(leer));

  // ===== N4 Befund fuer auto_commit ueber mehrere Traeger =====
  await anlegen('src/n4.ts', 'n4-alt\n');
  await res.addFileReservations({ project: PROJECT, agentId: F, filePaths: ['src/n4.ts'] });
  // Eigener Agent: plant W selbst, haengt planBatch die Op an Ws offenen Wait (shared_files n1+n4),
  // und der waere durch die lebende Reservierung auf n4 nicht mehr tot.
  const n4p = await batch.planBatch({ project: PROJECT, agent_id: 'ng-warte4', ops: [sr('src/n4.ts', 'n4-alt', 'n4-NEU')] });
  const n4 = typeof batch.nichtsGeschriebenBefund === 'function'
    ? await batch.nichtsGeschriebenBefund([n4p.plan_id, traeger1], 'auto_commit')
    : { fehlt: true };
  pruefe(n4.success === false && n4.error === 'nothing_written' && n4.grund === 'abgelaufen' && /auto_commit/.test(n4.message ?? '')
    && (n4.waits ?? []).length === 2,
    'N4: auto_commit-Befund ueber zwei Traeger: grund abgelaufen gewinnt, beide Waits genannt', n4);

  // ===== N5 Kontrolle =====
  await anlegen('src/n5.ts', 'n5-alt\n');
  const n5p = await batch.planBatch({ project: PROJECT, agent_id: W, ops: [sr('src/n5.ts', 'n5-alt', 'n5-NEU')] });
  const n5 = await versuch(() => batch.commitBatch({ plan_id: n5p.plan_id, agent_id: W }));
  pruefe(n5.success === true && (await inhalt('src/n5.ts')) === 'n5-NEU\n', 'N5: normaler Plan committet weiter mit success', n5);

  // ===== W1 Vorschau =====
  // tot: traeger1 (Reservierung abgelaufen). lebend: n4p (Reservierung von F auf n4 lebt).
  const vorschau = waitsMod ? await waitsMod.fuehreWaitsAus('waits_tot', { project: PROJECT }, 'ng-admin') : { fehlt: true };
  const tw = (vorschau.waits ?? []).find((w) => w.wait_token === token1);
  pruefe(vorschau.success === true && vorschau.vorschau === true && tw && tw.besitzer === W && tw.ziel_dateien?.[0] === 'src/n1.ts'
    && typeof tw.alter_minuten === 'number' && tw.ops?.[0]?.replace === 'n1-NEU' && typeof tw.basis_hashes?.['src/n1.ts'] === 'string',
    'W1: Vorschau zeigt toten Wait mit Besitzer, Ziel-Datei, Alter, vollen Ops und Basis-Hash', vorschau);
  const thoughtsVorher = (await pool.query(`SELECT COUNT(*)::int AS n FROM thoughts WHERE project = $1`, [PROJECT])).rows[0].n;
  pruefe((await waitStatus(token1)) === 'waiting' && thoughtsVorher === 0, 'W1: Vorschau aendert nichts', { wait: await waitStatus(token1), thoughtsVorher });

  // ===== W2 lebender Wait nicht gelistet =====
  const tokenLebt = n4p.coedit_waits?.[0]?.wait_token;
  pruefe(!(vorschau.waits ?? []).some((w) => w.wait_token === tokenLebt), 'W2: lebender Wait wird nicht als tot gelistet', vorschau.waits?.map((w) => w.wait_token));

  // ===== W3 ausfuehren =====
  const aus = waitsMod ? await waitsMod.fuehreWaitsAus('waits_tot', { project: PROJECT, ausfuehren: true }, 'ng-admin') : { fehlt: true };
  const gesichert = (aus.geschlossen ?? []).find((g) => g.wait_token === token1);
  const th = gesichert ? (await pool.query(`SELECT content, tags FROM thoughts WHERE id = $1`, [gesichert.thought_id])).rows[0] : null;
  pruefe(aus.success === true && gesichert && th && th.tags.includes('wait-sicherung') && th.tags.includes(W)
    && th.content.includes('n1-NEU') && th.content.includes('files(action:"plan"') && th.content.includes(tw?.basis_hashes?.['src/n1.ts'] ?? '###'),
    'W3: thought mit tags wait-sicherung + Besitzer, vollem Op-Inhalt, Basis-Hash und Anleitung', { aus, th });
  const ev = (await pool.query(`SELECT event_type, payload FROM agent_events WHERE project = $1 AND scope = $2`, [PROJECT, `agent:${W}`])).rows;
  pruefe(ev.some((e) => (e.payload ?? '').includes(gesichert?.thought_id ?? '###')), 'W3: Besitzer bekommt ein Event mit der thought-ID', ev);
  pruefe((await waitStatus(token1)) === 'closed' && (await planZeile(traeger1))?.status === 'cancelled',
    'W3: erst danach Wait closed und leerer Traeger verworfen', { wait: await waitStatus(token1), plan: await planZeile(traeger1) });
  pruefe((await waitStatus(tokenLebt)) === 'waiting', 'W3: lebender Wait bleibt unberuehrt', await waitStatus(tokenLebt));

  // ===== W4 wieder einspielen =====
  const ops = opsAusSicherung(th?.content);
  const w4p = ops ? await versuch(() => batch.planBatch({ project: PROJECT, agent_id: W, ops })) : { fehlt: true };
  const w4c = w4p?.plan_id && w4p.total_ops === 1 ? await versuch(() => batch.commitBatch({ plan_id: w4p.plan_id, agent_id: W })) : { fehlt: true, w4p };
  pruefe(w4c.success === true && (await inhalt('src/n1.ts')) === 'n1-NEU\n', 'W4: gesicherte Ops lassen sich mit files(plan) wieder einspielen', { ops, w4c });

  // ===== W5 ueber den Dispatcher =====
  const w5 = internMod ? await internMod.fuehreInternAus({ action: 'waits_tot', project: PROJECT }, 'ng-admin') : { fehlt: true };
  pruefe(w5.success === true && Array.isArray(w5.waits) && internMod.INTERN_ACTIONS.includes('waits_tot'),
    'W5: intern(waits_tot) ist registriert und liefert die Liste', w5);
} catch (err) {
  fehler++;
  console.error('FEHLER  Ausnahme: ' + (err instanceof Error ? err.stack : String(err)));
} finally {
  await aufraeumen().catch(() => {});
  await pool.end().catch(() => {});
}
console.log(fehler === 0 ? 'ERGEBNIS alle Zusagen erfuellt' : `ERGEBNIS ${fehler} Zusage(n) verletzt`);
process.exit(fehler === 0 ? 0 : 1);
