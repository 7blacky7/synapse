-- P22-T272 (User 01.11.2026): editor_pruefplaene (P22-T256, Rest des nie bestellten Tools editor_pruefplan) ist entfernt.
-- Spiegel aus schema.ts; frueher CREATE TABLE editor_pruefplaene samt Index idx_editor_pruefplaene_project. Idempotent.
DROP TABLE IF EXISTS editor_pruefplaene;
