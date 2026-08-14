-- Merkt sich den privaten Raider-Channel eines Mitglieds, damit das
-- Roster-Verwalten-Modul ihn beim Entfernen wiederfinden und zum Löschen
-- anbieten kann, statt danach im Server suchen zu müssen.

alter table members add column if not exists raider_channel_id text;
