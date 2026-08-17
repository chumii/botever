-- Einfache Gruppen-Anmeldung per /anmeldung: kein Kalender, kein Name, keine
-- Startzeit — nur eine feste Größe, optionale Freitext-Beschreibung und eine
-- Rollen-Anmeldeliste. Die ersten `size` Anmeldungen (nach signed_up_at) sind
-- "angemeldet", der Rest "Warteliste" — ergibt sich rein aus der Reihenfolge,
-- keine eigene Spalte dafür nötig.

create extension if not exists pgcrypto;

create table if not exists group_events (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  channel_id text not null,
  message_id text,
  creator_discord_id text not null,
  size integer not null default 5,
  description text,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now()
);

create table if not exists group_event_signups (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references group_events(id) on delete cascade,
  discord_user_id text not null,
  role text not null check (role in ('tank', 'healer', 'dd', 'tank_healer', 'tank_dd', 'healer_dd', 'any')),
  signed_up_at timestamptz not null default now(),
  unique (event_id, discord_user_id)
);
