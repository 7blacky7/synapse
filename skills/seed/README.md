# Seed-Skills

Kleine Skill-Datenbank im Repo (P23-T5). Wer das Repo uebernimmt, laedt sie in die eigene Skill-Datenbank.

- `fall-skills/*.json`: Fall-Skills `fall-<bereich>-<fall>` - je typischem Fall beim Tool-Aufruf ein Skill (Fehlbedienung, Sonderfall, Parameter-Detail). Je Tool eine Uebersicht `fall-<bereich>`.
- Format: `{ bereich, skills: [{ skill_name, weg: beide|ausweis|legacy, sections: [{ section, content, tags? }] }] }`. Jede Datei braucht eine Section `uebersicht` (Zweck + Ausloeser).
- `weg`: Inhalte, die sich zwischen Agenten mit Ausweis (token) und ohne Ausweis (agent_id/project/role) unterscheiden, stehen in getrennten Skills. Der Hinweis bei Fehlbedienung waehlt automatisch nach dem Aufrufer.

## Laden

```bash
node scripts/skills-seed-laden.mjs            # Trockenlauf: fehlend / vorhanden
node scripts/skills-seed-laden.mjs --laden    # fehlende anlegen, vorhandene ueberspringen
node scripts/skills-seed-laden.mjs --laden --aktualisieren   # zusaetzlich geaenderte Seed-Skills ersetzen
mise run skills-seed                          # = --laden
```

Der Lader spricht das `skills`-Tool der Synapse-API an (Adresse/Token aus `~/.synapse/file-watcher/config.json` oder `SYNAPSE_API_URL`/`SYNAPSE_API_TOKEN`). Er gehoert als Schritt nach jedem Deploy in den Ablauf; vorhandene Skills bleiben unberuehrt.

## Wirkung in Synapse

- Produkt-Schalter `fall_skill_hinweis`: Fehlerantworten nennen beim ersten Auftreten je Sitzung den passenden Fall-Skill (`fall_skill: {name, abruf, ausloeser}`).
- Produkt-Schalter `tool_beschreibungen_kurz`: tools/list liefert kurze Tool-Beschreibungen, die nur noch auf die Fall-Skills verweisen.
- Beide Standard AUS; schalten mit `admin(profil_schalter_setzen, profil_funktion, aktiv, grund, ebene)` oder in der Web-UI (Agenten-Ausweis, Fall-Skills).
