-- Stabile Discord-Identität für Mitglieder.
--
-- Bisher wurden Mitglieder über discord_name gefunden. Discord-Namen sind
-- änderbar; nach einer Umbenennung legte der Bot einen zweiten Datensatz an und
-- die bisherigen Abmeldungen waren für die Person nicht mehr sichtbar. Die
-- Discord-User-ID ist dagegen unveränderlich.
--
-- Die Spalte bleibt nullable: bestehende Zeilen werden erst befüllt, wenn die
-- jeweilige Person das nächste Mal mit dem Bot interagiert (siehe
-- findOrCreateMember in src/commands/utility/abmeldungen.ts).

alter table members add column if not exists discord_id text;

create unique index if not exists members_discord_id_key on members (discord_id);
