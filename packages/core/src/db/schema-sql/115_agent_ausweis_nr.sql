
-- P22-T35 / 115 (Welle 12). Additiv und idempotent: nur CREATE SEQUENCE IF NOT EXISTS, nichts wird gedroppt.
-- Fortlaufende Ausweisnummer (User 19.10.2026 ~16:55: bei 1 Zeichen anfangen, spaeter 2, 3, 4 ...). Die Nummer wird in
-- agent-ausweis-format.ts bijektiv im 31-Zeichen-Alphabet kodiert ('sai_' + Kodierung). Nummern werden nie
-- wiederverwendet: nextval wird auch bei Rollback oder nach dem Loeschen eines Ausweises nicht zurueckgesetzt.
-- Eindeutigkeit zusaetzlich ueber uq_agent_identitaet_tokens_offen (114).
CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr;
