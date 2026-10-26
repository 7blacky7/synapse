/**
 * P25-T10 (Inventur 2f2f6776 Gruppe C): Private Testschemata bauen ihre Tabellen aus einer Handliste von
 * schema-sql-Dateien bzw. *-schema.js. Spaeter hinzugekommene Spalten (z. B. policy_pin aus P18-T104,
 * *_identity_id aus agent-bezug-schema P22, uebernahme aus reverse-einstellwerte-schema P18-T86) fehlen dort,
 * waehrend der Produktcode sie liest -> "column ... does not exist".
 *
 * zieheSpaltenNach ergaenzt jede Tabelle des privaten Schemas, die es gleichnamig in public gibt, um die Spalten,
 * die nur public hat. public in synapse_test haelt der Gesamtlaeufer per Schema-Nachzug (ensureSchema) aktuell,
 * damit folgt das private Schema dem echten Schema-Code, ohne dass jeder Test die Liste nachpflegt.
 * Uebernommen werden Typ und Standardwert; NOT NULL nur zusammen mit einem Standardwert, damit bestehende
 * Fixture-INSERTs ohne die neue Spalte gueltig bleiben. Fremdschluessel, CHECKs, Indizes und Trigger der neuen
 * Spalten werden NICHT kopiert (Tests, die diese pruefen, laden die passende Migration selbst).
 * Generierte Spalten werden als GENERATED ... STORED uebernommen, Identity-Spalten als normale Spalte.
 *
 * db: Objekt mit query(sql, werte) gegen synapse_test (Pool, Client oder Wrapper; search_path egal).
 * schema: Name des privaten Schemas. optionen.tabellen: nur diese Tabellen (Standard: alle des Schemas).
 * Rueckgabe: Liste 'tabelle.spalte' der ergaenzten Spalten (fuer Herkunft/Debug).
 */
const ident = (s) => '"' + String(s).replaceAll('"', '""') + '"';

export async function zieheSpaltenNach(db, schema, optionen = {}) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema) || schema === 'public') throw new Error('zieheSpaltenNach: ungueltiges privates Schema ' + schema);
  const tabellen = optionen.tabellen ?? null;
  const { rows } = await db.query(`
    SELECT pc.relname AS tabelle, pa.attname AS spalte, format_type(pa.atttypid, pa.atttypmod) AS typ,
           pg_get_expr(ad.adbin, ad.adrelid) AS standard, pa.attnotnull AS pflicht, pa.attgenerated AS generiert
      FROM pg_class pc
      JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = 'public'
      JOIN pg_namespace tn ON tn.nspname = $1
      JOIN pg_class tc ON tc.relnamespace = tn.oid AND tc.relname = pc.relname AND tc.relkind IN ('r', 'p')
      JOIN pg_attribute pa ON pa.attrelid = pc.oid AND pa.attnum > 0 AND NOT pa.attisdropped
      LEFT JOIN pg_attrdef ad ON ad.adrelid = pc.oid AND ad.adnum = pa.attnum
     WHERE pc.relkind IN ('r', 'p')
       AND ($2::text[] IS NULL OR pc.relname = ANY($2::text[]))
       AND NOT EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = tc.oid AND x.attname = pa.attname AND NOT x.attisdropped)
     ORDER BY pc.relname, pa.attnum`, [schema, tabellen]);
  const ergaenzt = [];
  for (const r of rows) {
    let def = ident(r.spalte) + ' ' + r.typ;
    if (r.generiert === 's' && r.standard) def += ' GENERATED ALWAYS AS (' + r.standard + ') STORED';
    else if (r.standard) def += ' DEFAULT ' + r.standard + (r.pflicht ? ' NOT NULL' : '');
    await db.query('ALTER TABLE ' + ident(schema) + '.' + ident(r.tabelle) + ' ADD COLUMN IF NOT EXISTS ' + def);
    ergaenzt.push(r.tabelle + '.' + r.spalte);
  }
  return ergaenzt;
}
