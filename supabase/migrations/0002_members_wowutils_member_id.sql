-- Verknüpfung zwischen einem Bot-Mitglied und seinem WoWUtils-Roster-Eintrag.
--
-- Die WoWUtils-API gibt die Discord-ID eines Mitglieds nur im Readiness-Endpunkt
-- heraus, und dort auch nur für Leute, die gerade noch etwas erledigen müssen.
-- Eine verlässliche automatische Auflösung gibt es damit nicht, deshalb wird die
-- Zuordnung einmal ermittelt und hier festgehalten.
--
-- Erstbefüllung über scripts/wowutils-seed-mapping.ts (schlägt Zuordnungen über
-- den Namen vor); alles Weitere über den Verknüpfen-Button in /abmeldungen.

alter table members add column if not exists wowutils_member_id text;

create unique index if not exists members_wowutils_member_id_key on members (wowutils_member_id);
